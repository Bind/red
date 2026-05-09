# CI workflows and release guards

set dotenv-load

# Verify that a dotenvx env file contains the required secrets for a deploy target.
secrets-check env_file=".env.ci" stage="production":
    #!/usr/bin/env bash
    set -euo pipefail
    keys=(
      HCLOUD_TOKEN
      CLOUDFLARE_API_TOKEN
      CLOUDFLARE_ZONE_ID
      CLOUDFLARE_DEFAULT_ACCOUNT_ID
    )
    if [[ "{{ stage }}" == "production" ]]; then
      keys+=(HETZNER_SSH_PUBLIC_KEY HETZNER_SSH_PRIVATE_KEY)
    else
      keys+=(DEV_SSH_PUBLIC_KEY DEV_SSH_PRIVATE_KEY)
    fi
    for key in "${keys[@]}"; do
      ./infra/platform/get-required-dotenvx-value.sh "$key" "{{ env_file }}" >/dev/null
    done
    echo "validated {{ env_file }} for {{ stage }}"

# Assert that the canonical release images already exist in GHCR for a commit SHA.
assert-release-images git_commit owner="bind":
    #!/usr/bin/env bash
    set -euo pipefail
    images=(
      red-gateway
      red-api
      red-bff
      red-auth
      red-obs
      red-grs
      red-web
    )
    for image in "${images[@]}"; do
      ref="ghcr.io/{{ owner }}/${image}:{{ git_commit }}"
      docker manifest inspect "$ref" >/dev/null
      echo "found $ref"
    done

# Add a human-friendly release tag to already-built GHCR images without rebuilding them.
retag-release-images git_commit release_tag owner="bind":
    #!/usr/bin/env bash
    set -euo pipefail
    images=(
      red-gateway
      red-api
      red-bff
      red-auth
      red-obs
      red-grs
      red-web
    )
    for image in "${images[@]}"; do
      src="ghcr.io/{{ owner }}/${image}:{{ git_commit }}"
      dst="ghcr.io/{{ owner }}/${image}:{{ release_tag }}"
      docker buildx imagetools create -t "$dst" "$src" >/dev/null
      echo "tagged $dst -> $src"
    done

# Compute the next patch release tag from the existing semver tag set.
next-release-tag prefix="v":
    #!/usr/bin/env bash
    set -euo pipefail
    latest_tag="$(git tag --list '{{ prefix }}[0-9]*.[0-9]*.[0-9]*' --sort=-version:refname | head -n1)"
    if [[ -z "${latest_tag}" ]]; then
      printf '%s\n' "{{ prefix }}0.0.1"
      exit 0
    fi
    version="${latest_tag#{{ prefix }}}"
    IFS='.' read -r major minor patch <<<"${version}"
    printf '%s%d.%d.%d\n' "{{ prefix }}" "${major}" "${minor}" "$((patch + 1))"

# Poll the latest main commit through image build, release deploy, and prod health.
watch-main-release interval="300" branch="main" production_url="https://red.computer" owner="Bind" repo="red":
    #!/usr/bin/env bash
    set -euo pipefail
    mkdir -p .git/release-watch
    log_file=".git/release-watch/$(date -u +%Y%m%dT%H%M%SZ).log"
    echo "watching {{ owner }}/{{ repo }} {{ branch }} every {{ interval }}s -> $log_file"
    while true; do
      timestamp="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
      git fetch --quiet origin --tags
      main_sha="$(gh api repos/{{ owner }}/{{ repo }}/commits/{{ branch }} --jq .sha)"
      release_tag="$(git tag --points-at "$main_sha" --list 'v*' --sort=-version:refname | head -n1 || true)"
      build_run="$(
        gh run list --workflow build-app-images.yml --branch {{ branch }} --limit 20 \
          --json databaseId,headSha,status,conclusion,url,createdAt \
        | jq -c --arg sha "$main_sha" 'map(select(.headSha == $sha)) | first // {}'
      )"
      release_run="$(
        gh run list --workflow release.yml --limit 20 \
          --json databaseId,headSha,status,conclusion,url,createdAt,displayTitle \
        | jq -c --arg sha "$main_sha" 'map(select(.headSha == $sha)) | first // {}'
      )"
      health="skipped"
      if [[ "$(echo "$release_run" | jq -r '.conclusion // empty')" == "success" ]]; then
        if just deploy-check "{{ production_url }}" >>"$log_file" 2>&1; then
          health="ok"
        else
          health="failed"
        fi
      fi
      jq -nc \
        --arg timestamp "$timestamp" \
        --arg branch "{{ branch }}" \
        --arg main_sha "$main_sha" \
        --arg release_tag "$release_tag" \
        --arg health "$health" \
        --argjson build_run "$build_run" \
        --argjson release_run "$release_run" \
        '{
          timestamp: $timestamp,
          branch: $branch,
          main_sha: $main_sha,
          release_tag: ($release_tag | select(length > 0)),
          build_run: $build_run,
          release_run: $release_run,
          production_health: $health
        }' | tee -a "$log_file"
      sleep {{ interval }}
    done
