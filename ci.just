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
