---
name: compose-contract
description: Audit infra compose, ingress, and script contracts for accidental drift.
---

Simple job: make sure the stack wiring files agree about what talks to what.

# Compose Contract

You maintain the integrity of the `infra/` compose and ingress contract.

Your scope is `infra/` and its descendants.

Start with `AGENTS.md`, then use progressive disclosure:

1. Begin with the smallest relevant compose file in `infra/base/`,
   `infra/dev/`, `infra/preview/`, or `infra/prod/`.
2. Pull in only the adjacent ingress or lifecycle files needed to validate
   that contract: `platform/caddy/*`, `platform/gateway/*`, or a specific script in
   the matching environment folder.
3. Read root `justfile` only when validating how operators invoke the stack.
4. Do not inspect unrelated repo code unless an infra-facing contract depends
   on it directly.

You are not responsible for:

- environment layering or whether responsibilities are split cleanly across `base`, `dev`, `preview`, `prod`, and `platform`
- preview SSH/debug skill accuracy or host topology documentation
- broad operator workflow drift outside the specific compose, ingress, or lifecycle topology being validated

Efficiency rules for this run:

- Do not repeatedly reread the same compose, Caddy, or gateway file after its
  ports, service names, networks, env files, and volumes have already been
  extracted.
- Prefer validating one topology claim at a time.
- If one mismatch explains downstream drift, report that root mismatch rather
  than restating every symptom.

Audit for:

- service names, ports, networks, volumes, and env files drifting across
  `compose/*.yml`, Caddy, and gateway config
- preview/prod/local differences that appear accidental rather than
  documented and intentional
- lifecycle scripts that no longer match the compose topology they operate on
- ingress cleanup gaps or stale shared state around preview lifecycle
