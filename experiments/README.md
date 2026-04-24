# Experiments

`experiments/` is for isolated spikes, labs, and canaries that are useful to keep
in-repo but are not part of the main product surface.

## What belongs here

- focused technical probes
- runner or agent backend spikes
- protocol or auth labs
- long-running canaries that are still experimental

If something becomes productized, it should usually move into `apps/` or `pkg/`.

## Starting a new experiment

Create a new package under `experiments/<name>/` and keep it self-contained.

Preferred shape:

- `src/`
- `README.md`
- `package.json`
- `justfile`
- `tsconfig.json`
- `bun.lock`

Add these when the experiment needs them:

- `Dockerfile`
- `docker-compose.yml`
- `compose/`
- `prompts/`
- `src/service/`
- `src/store/`
- `src/util/`
- `src/test/`

Conventions:

- use Bun for runtime
- use `just` as the command runner
- prefer a collocated `justfile` inside each experiment instead of adding experiment-specific recipes to the root `justfile`
- keep routes thin and push behavior into services
- prefer in-process tests first, then compose E2E where it adds signal
- keep the README limited to commands and behavior the experiment actually supports

## Current experiments

### `ci-runner-lab`

GitHub Actions-style runner lab:

- accepts workflow runs over HTTP
- queues and executes shell steps locally
- persists run status and step logs
- includes compose E2E for basic lifecycle verification

### `durable-workflow-lab`

Authoring spec for a TypeScript-first durable workflow model:

- `async`/`await` authoring with explicit durable `step()` boundaries
- Bun-shell-compatible `sh` primitive for shell-heavy workflow steps
- focused on workflow authoring UX rather than worker/runtime internals

### `codemode-lab`

Runtime probe for the `smithers.sh` / `executor.sh` style flow:

- model writes TypeScript files directly
- Bun executes the generated module as the unit of work
- captures logs and structured return values over HTTP

### `jwks-auth-lab`

Small auth/JWKS lab. Minimal structure is fine here because the scope is narrow.

### `opencode-lab`

Runner/backend spike for evaluating `opencode`. It uses `container/` and
`prompts/` because those are the relevant assets for this experiment.

## Cleanup rules

- do not commit `node_modules/`
- keep local scratch experiments out of git until they have a real README and package shape
- prefer one clear experiment per directory over dumping unrelated probes together
- when an experiment stalls out, either remove it or leave a short README note about current status and limits
