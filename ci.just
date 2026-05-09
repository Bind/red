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
