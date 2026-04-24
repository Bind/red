---
name: debug-preview
description: Debug a redc preview deployment on the shared Hetzner box. Use when a preview URL, deploy, remote service, or per-PR stack needs investigation over SSH, or when you need to find where preview services, logs, caddy routes, env files, and compose state live on the host.
---

# Debug Preview

Use this skill for per-PR preview issues on the shared dev box.

## Workflow

1. Identify the preview slug and project.

- PR `9` maps to slug `pr-9`.
- The docker compose project is `preview-pr-9`.
- The public URL is `https://pr-9.preview.red.computer`.

2. SSH to the preview box as `root`.

- Preferred port is `2222`.
- Get the SSH key from `dotenvx` and use a temporary key file if needed.
- If the host IP is unknown, check the latest preview deploy workflow or local operator docs first.

3. Inspect the host before diving into app logs.

- Read [references/topology.md](references/topology.md) for the box layout and service map.
- Start with `docker ps`, `docker logs`, disk headroom, and `/opt/redc-previews/<slug>`.
- Confirm the matching Caddy site exists under `/opt/redc-preview-caddy/caddy/sites/`.

4. Stay narrow to one preview stack.

- Prefer `preview-<slug>-*` containers only.
- Use the compose files in `/opt/redc-previews/<slug>/infra/base/compose.yml` and `/opt/redc-previews/<slug>/infra/preview/compose.yml`.
- Avoid global cleanup unless the problem is clearly host-wide.

5. Report findings with the exact layer that failed.

- ingress/Caddy routing
- compose pull/up
- container crash loop
- app-level request failure
- host resource exhaustion

## Quick checks

- Is `preview-caddy` up?
- Does `/opt/redc-preview-caddy/caddy/sites/<slug>.caddy` exist?
- Are `preview-<slug>-gateway` and the target service containers running?
- Is `/opt/redc-previews/.env` present?
- Is `/opt/redc-previews/<slug>` populated with the current repo checkout?
- Are disk, memory, or image-pull failures blocking startup?

## References

- Read [references/topology.md](references/topology.md) for SSH patterns, host paths, service/container names, internal ports, and common debug commands.
