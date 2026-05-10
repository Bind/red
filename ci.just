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

# Health-check a domain against a specific IP before public DNS has converged.
deploy-check-resolve url host ip:
    #!/usr/bin/env bash
    set -euo pipefail
    body="$(
      curl -fsSL \
        --retry 12 \
        --retry-delay 5 \
        --retry-all-errors \
        --max-time 15 \
        --resolve "{{ host }}:443:{{ ip }}" \
        "{{ url }}/health"
    )"
    echo "$body" | jq .
    status="$(echo "$body" | jq -r .status)"
    if [ "$status" != "ok" ]; then
      echo "health status is $status"
      exit 1
    fi

# Wait for an HTTP(S) health endpoint to return {"status":"ok"}.
wait-for-health url timeout_seconds="600" poll_seconds="10":
    #!/usr/bin/env bash
    set -euo pipefail
    deadline=$(( $(date +%s) + {{ timeout_seconds }} ))
    while (( $(date +%s) < deadline )); do
      if body="$(curl -fsSL --max-time 15 "{{ url }}/health" 2>/dev/null)"; then
        echo "$body" | jq .
        status="$(echo "$body" | jq -r .status)"
        if [[ "$status" == "ok" ]]; then
          echo "{{ url }} is healthy"
          exit 0
        fi
        echo "waiting for {{ url }} health=ok; got status=${status}"
      else
        echo "waiting for {{ url }} to respond successfully"
      fi
      sleep {{ poll_seconds }}
    done
    echo "error: timed out waiting for {{ url }}/health" >&2
    exit 1

# Update the production Cloudflare A record to the provisioned server IP.
promote-production-dns env_file=".env.ci":
    #!/usr/bin/env bash
    set -euo pipefail
    zone_id="$(dotenvx get CLOUDFLARE_ZONE_ID -f "{{ env_file }}" --format shell)"
    api_token="$(dotenvx get CLOUDFLARE_API_TOKEN -f "{{ env_file }}" --format shell)"
    host="$(dotenvx get RED_DNS_RECORD -f "{{ env_file }}" --format shell)"
    target_ip="$(dotenvx get RED_SERVER_IP -f "{{ env_file }}" --format shell)"
    records="$(
      curl -fsS \
        -H "Authorization: Bearer ${api_token}" \
        "https://api.cloudflare.com/client/v4/zones/${zone_id}/dns_records?type=A&name=${host}"
    )"
    count="$(echo "$records" | jq '.result | length')"
    if [[ "$count" -gt 1 ]]; then
      echo "error: expected exactly one A record for ${host}, found ${count}" >&2
      echo "$records" | jq '.result[] | {id,name,content,type}'
      exit 1
    fi
    if [[ "$count" -eq 0 ]]; then
      curl -fsS -X POST \
        -H "Authorization: Bearer ${api_token}" \
        -H "Content-Type: application/json" \
        "https://api.cloudflare.com/client/v4/zones/${zone_id}/dns_records" \
        --data "$(jq -nc --arg host "$host" --arg ip "$target_ip" '{type:"A",name:$host,content:$ip,ttl:300,proxied:false}')" \
        >/dev/null
      echo "created ${host} -> ${target_ip}"
      exit 0
    fi
    record_id="$(echo "$records" | jq -r '.result[0].id')"
    current_ip="$(echo "$records" | jq -r '.result[0].content')"
    if [[ "$current_ip" == "$target_ip" ]]; then
      echo "${host} already points to ${target_ip}"
      exit 0
    fi
    curl -fsS -X PATCH \
      -H "Authorization: Bearer ${api_token}" \
      -H "Content-Type: application/json" \
      "https://api.cloudflare.com/client/v4/zones/${zone_id}/dns_records/${record_id}" \
      --data "$(jq -nc --arg host "$host" --arg ip "$target_ip" '{type:"A",name:$host,content:$ip,ttl:300,proxied:false}')" \
      >/dev/null
    echo "updated ${host}: ${current_ip} -> ${target_ip}"

# Wait until public DNS resolves a host to the expected IPv4 address.
wait-for-dns host expected_ip timeout_seconds="300" poll_seconds="10":
    #!/usr/bin/env bash
    set -euo pipefail
    deadline=$(( $(date +%s) + {{ timeout_seconds }} ))
    while (( $(date +%s) < deadline )); do
      answers="$(
        if command -v dig >/dev/null 2>&1; then
          dig +short "{{ host }}" A
        else
          getent ahostsv4 "{{ host }}" | awk '{print $1}' | sort -u
        fi
      )"
      if printf '%s\n' "$answers" | grep -Fx "{{ expected_ip }}" >/dev/null; then
        echo "{{ host }} resolves to {{ expected_ip }}"
        exit 0
      fi
      echo "waiting for {{ host }} -> {{ expected_ip }}; current answers: ${answers:-<none>}"
      sleep {{ poll_seconds }}
    done
    echo "error: timed out waiting for {{ host }} to resolve to {{ expected_ip }}" >&2
    exit 1
