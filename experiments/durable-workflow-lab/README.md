# Durable Workflow Lab

Experiment spec for a TypeScript-first durable workflow authoring model with
Bash as the default step payload.

This is intentionally focused on authoring experience, not the general worker
system, queueing, or distributed runtime concerns.

## Goal

Provide GitHub Actions-style step observability and resumability without making
authors write GitHub Actions YAML.

The intended split is:

- use plain Bash for simple scripts
- use TypeScript `async`/`await` for durable and resumable workflows
- use Bash inside durable workflows as a step primitive

## Product Position

The workflow language is TypeScript.

Bash is not the workflow language. Bash is the side-effect language used inside
workflow steps.

This avoids trying to make arbitrary shell scripts durable while preserving the
part of shell authoring that both humans and agents are already good at.

## Core Model

Durable workflows are ordinary TypeScript `async`/`await` code with explicit
`step()` boundaries.

- `workflow(...)` defines the workflow
- `step(...)` defines a durable boundary
- `sh` provides Bun-shell-compatible command execution inside a step

Completed steps are replayed from stored results on resume instead of being
re-executed.

## Authoring Principles

- optimize for agent-authored TypeScript
- keep the API small and predictable
- make durable boundaries visually obvious
- allow arbitrary TypeScript inside steps
- allow multiple shell calls inside a step
- recommend small, single-purpose steps
- require step outputs to be serializable
- keep runtime internals out of the author-facing API

## Non-Goals

- arbitrary Bash as a durable workflow format
- GitHub Actions YAML compatibility
- exposing queue, lease, or worker mechanics in the authoring API
- building a graph DSL before validating the `async`/`await` authoring model

## Proposed API

```ts
import { workflow } from "@redc/workflows";

export default workflow("deploy", async ({ input, step, sh }) => {
  await step("clone", async () => {
    await sh`git clone ${input.repoUrl} repo`;
    await sh`git -C repo checkout ${input.branch}`;
  });

  const build = await step("build", async () => {
    await sh`make -C repo build`;
    return { artifactPath: "repo/dist/app.tgz" };
  });

  await step("publish", async () => {
    await sh`deploy ${build.artifactPath}`;
  });
});
```

## First-Pass API Signatures

These signatures are the proposed contract for the authoring layer. They are
intentionally small and are judged against the canonical examples below.

```ts
import type { ZodType } from "zod";

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type WorkflowValue = JsonValue | undefined;

export interface WorkflowDefinition<TInput extends WorkflowValue, TOutput extends WorkflowValue> {
  id: string;
  run(ctx: WorkflowContext<TInput>): Promise<TOutput>;
}

export interface WorkflowContext<TInput extends WorkflowValue> {
  input: TInput;
  step: StepRunner;
  sh: ShellTemplate;
  sleep: SleepFn;
  log: LogFn;
}

export interface StepOptions<TOutput extends WorkflowValue = WorkflowValue> {
  output?: ZodType<TOutput>;
  retry?: number;
  timeout?: string | number;
}

export interface ShellOptions {
  cwd?: string;
  env?: Record<string, string>;
  timeout?: string | number;
}

export interface ShellResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  text(): Promise<string>;
  json<T>(): Promise<T>;
  lines(): Promise<string[]>;
}

export interface StepRunner {
  <TOutput extends WorkflowValue>(
    name: string,
    run: () => Promise<TOutput>,
  ): Promise<TOutput>;

  <TOutput extends WorkflowValue>(
    name: string,
    options: StepOptions<TOutput>,
    run: () => Promise<TOutput>,
  ): Promise<TOutput>;
}

export interface ShellTemplate {
  (pieces: TemplateStringsArray, ...values: unknown[]): Promise<ShellResult>;
  with(options: ShellOptions): ShellTemplate;
}

export type SleepFn = (duration: string | number) => Promise<void>;
export type LogFn = (...parts: unknown[]) => Promise<void> | void;

export function workflow<TInput extends WorkflowValue = undefined, TOutput extends WorkflowValue = undefined>(
  id: string,
  run: (ctx: WorkflowContext<TInput>) => Promise<TOutput>,
): WorkflowDefinition<TInput, TOutput>;

export function workflow<TInput extends WorkflowValue, TOutput extends WorkflowValue>(
  definition: {
    id: string;
    input?: ZodType<TInput>;
    output?: ZodType<TOutput>;
  },
  run: (ctx: WorkflowContext<TInput>) => Promise<TOutput>,
): WorkflowDefinition<TInput, TOutput>;
```

### Signature Notes

- `workflow()` supports a minimal string form and an object form with optional schemas
- `step()` supports a minimal form and an options form
- `step()` returns the durable output value directly
- `sh` is a template literal function with a `.with(...)` helper for scoped options
- `sleep` and `log` are included because they are likely to be needed early and do not add much API weight

## API Semantics

### `workflow()`

Minimal form:

```ts
export default workflow("deploy", async ({ step, sh }) => {
  await step("clone", async () => {
    await sh`git clone https://example.com/repo.git repo`;
  });
});
```

Typed form:

```ts
export default workflow(
  {
    id: "deploy",
    input: z.object({
      repoUrl: z.string().url(),
      branch: z.string(),
    }),
    output: z.object({
      deployed: z.boolean(),
    }),
  },
  async ({ input, step, sh }) => {
    await step("clone", async () => {
      await sh`git clone ${input.repoUrl} repo`;
      await sh`git -C repo checkout ${input.branch}`;
    });

    return { deployed: true };
  },
);
```

Contract:

- workflow id must be stable and human-readable
- workflow input is available at `ctx.input`
- workflow return value is the final workflow output
- code between steps may perform pure orchestration logic only

### `step()`

Minimal form:

```ts
const build = await step("build", async () => {
  await sh`make build`;
  return { artifactPath: "dist/app.tgz" };
});
```

Options form:

```ts
const build = await step(
  "build",
  {
    retry: 2,
    timeout: "10m",
    output: z.object({
      artifactPath: z.string(),
    }),
  },
  async () => {
    await sh`make build`;
    return { artifactPath: "dist/app.tgz" };
  },
);
```

Contract:

- step name is the unit of observability in the UI and logs
- step name should be stable within a workflow definition
- step output must be serializable
- a completed step resolves from stored output during replay
- side effects should happen inside `step()`, not outside it

### `sh`

Basic usage:

```ts
await sh`git clone ${input.repoUrl} repo`;
```

Collecting text output:

```ts
const sha = (await sh`git rev-parse HEAD`.text()).trim();
```

Scoped options:

```ts
const repoSh = sh.with({
  cwd: "repo",
  env: { NODE_ENV: "production" },
  timeout: "5m",
});

await repoSh`bun test`;
await repoSh`bun run build`;
```

Contract:

- `sh` should preserve Bun shell ergonomics as much as possible
- interpolation should be safe and unsurprising
- stdout and stderr should attach to the current step
- using `sh` outside `step()` should be invalid or strongly discouraged

### `sleep()`

Example:

```ts
await step("settle", async () => {
  await sleep("5m");
});
```

Contract:

- `sleep()` represents a durable wait, not a blocking process sleep
- duration strings should accept a small, documented format such as `5m` or `30s`

### `log()`

Example:

```ts
await step("summarize", async () => {
  log("starting summary generation");
});
```

Contract:

- `log()` is for structured operator-facing messages that are not shell output
- logs should attach to the current step when called inside one
- logs outside steps may attach to run-level metadata if supported

## Canonical Examples

These examples are the reference set for evaluating the authoring model. They
should stay small, realistic, and readable to both humans and agents.

### 1. Linear Deploy

```ts
import { workflow } from "@redc/workflows";

export default workflow("deploy", async ({ input, step, sh }) => {
  await step("clone", async () => {
    await sh`git clone ${input.repoUrl} repo`;
    await sh`git -C repo checkout ${input.branch}`;
  });

  const build = await step("build", async () => {
    await sh`make -C repo build`;
    return { artifactPath: "repo/dist/app.tgz" };
  });

  await step("publish", async () => {
    await sh`deploy ${build.artifactPath}`;
  });
});
```

Why it matters:

- establishes the baseline mental model
- shows durable sequencing with minimal ceremony
- shows typed data flowing from one step to the next

### 2. Build With Typed Step Output

```ts
import { z } from "zod";
import { workflow } from "@redc/workflows";

export default workflow("build-release", async ({ input, step, sh }) => {
  await step("install", async () => {
    await sh`bun install`;
  });

  const build = await step(
    "build",
    {
      output: z.object({
        version: z.string(),
        artifactPath: z.string(),
      }),
    },
    async () => {
      await sh`bun run build`;
      const version = (await sh`node -p "require('./package.json').version"`.text()).trim();
      return {
        version,
        artifactPath: `dist/app-${version}.tgz`,
      };
    },
  );

  await step("announce", async () => {
    await sh`echo built ${build.artifactPath} for version ${build.version}`;
  });
});
```

Why it matters:

- shows that inference is the default, but explicit schemas remain available
- shows lightweight parsing around shell output
- keeps data flow in TypeScript rather than stringly shell glue

### 3. Branch On Prior Step Result

```ts
import { workflow } from "@redc/workflows";

export default workflow("conditional-deploy", async ({ step, sh }) => {
  const checks = await step("checks", async () => {
    const status = (await sh`./scripts/health-check`.text()).trim();
    return {
      healthy: status === "ok",
    };
  });

  if (!checks.healthy) {
    await step("abort", async () => {
      await sh`echo refusing to deploy because health checks failed`;
    });
    return { deployed: false };
  }

  await step("deploy", async () => {
    await sh`./scripts/deploy`;
  });

  return { deployed: true };
});
```

Why it matters:

- proves that control flow can stay idiomatic TypeScript
- makes the replay contract concrete: branching depends on prior durable outputs
- avoids introducing a separate graph DSL for simple workflow branching

### 4. Wait And Resume

```ts
import { workflow } from "@redc/workflows";

export default workflow("rollout-check", async ({ input, step, sh, sleep }) => {
  await step("deploy", async () => {
    await sh`./scripts/start-rollout ${input.releaseId}`;
  });

  await step("settle", async () => {
    await sleep("5m");
  });

  const verify = await step("verify", async () => {
    const status = (await sh`./scripts/rollout-status ${input.releaseId}`.text()).trim();
    return { status };
  });

  if (verify.status !== "healthy") {
    await step("rollback", async () => {
      await sh`./scripts/rollback ${input.releaseId}`;
    });
  }
});
```

Why it matters:

- shows a long-running workflow shape without adding queue mechanics to the API
- demonstrates that waits are a workflow concern, not a shell hack
- gives a concrete target for resume behavior after process restart

### 5. Small Multi-Command Step

```ts
import { workflow } from "@redc/workflows";

export default workflow("package-app", async ({ step, sh }) => {
  const pkg = await step("package", async () => {
    await sh`bun install`;
    await sh`bun test`;
    await sh`bun run build`;
    const sha = (await sh`git rev-parse HEAD`.text()).trim();
    return {
      sha,
      tarball: `dist/app-${sha.slice(0, 8)}.tgz`,
    };
  });

  await step("report", async () => {
    await sh`echo packaged ${pkg.tarball}`;
  });
});
```

Why it matters:

- demonstrates the intended flexibility inside a step
- shows what an acceptable multi-command step looks like
- reinforces the guidance that a step may be composed, but should still represent one operational unit

## API Constraints

### `workflow`

- names the workflow
- provides typed input and output
- receives a small context object
- should feel like ordinary TypeScript rather than a custom DSL

### `step`

- is the only durable boundary in v1
- may contain multiple shell calls
- may contain lightweight TypeScript logic
- should usually represent one logical unit of work
- returns a serializable value that may be used by later steps

### `sh`

- should feel like Bun's `$` template literal API
- should only be used for side effects inside a `step`
- should support common options such as cwd, env, and timeout
- should capture stdout and stderr for step-level observability

Illustrative shape:

```ts
await step("build", async () => {
  await sh`npm ci`;
  await sh`npm run build`;
  const version = await sh`node -p "require('./package.json').version"`.text();
  return { version: version.trim() };
});
```

## Guidance For Step Size

Recommended:

- one step per meaningful operational unit
- one retry boundary per step
- one readable step name per unit of work

Acceptable:

- a few tightly related shell commands in one step
- small parsing or data-shaping logic around shell output

Discouraged:

- stuffing an entire deployment or build pipeline into one step
- depending on ambient in-memory shell session state across steps
- writing side effects outside `step()`

## Mental Model

Authors should think in this shape:

1. TypeScript decides sequencing, branching, and data flow.
2. Bash performs concrete system work.
3. `step()` defines what can be resumed safely.
4. Observability hangs off named steps, not raw shell text.

## Replay and Resume Semantics

Author-facing contract:

- a completed step is not rerun on resume
- a later step can consume a prior step's stored output as a normal TS value
- interrupted or failed steps resume according to runtime policy
- code outside a step should not perform external side effects

The important authoring consequence is that workflow code must be written so
replay from the top is safe as long as completed `step()` calls are memoized.

## v1 Scope

Include:

- sequential workflows
- typed workflow input
- typed step outputs
- `step()`
- Bun-shell-compatible `sh`
- step names, timings, logs, and final status
- replay from stored step outputs

Defer:

- parallel execution
- signals and approvals
- nested workflows
- distributed execution
- custom graph builders

## Example Set Expectations

The canonical examples above should remain the standard review set for API
changes. A workflow authoring change is suspect if it makes these examples:

- more verbose
- less readable
- harder for an agent to generate correctly
- more dependent on framework-specific syntax than ordinary TypeScript

## Evaluation Questions

- can an agent reliably generate valid workflows with this API?
- can a human read the result and immediately understand resume boundaries?
- does `step()` provide enough structure without feeling like YAML in disguise?
- does Bun-style shell interpolation make shell-heavy steps pleasant to write?
- are optional typed schemas needed, or is inference enough for most cases?

## Open Questions

- should `step()` optionally accept retry and timeout options in v1?
- should `workflow()` require schemas, or make them optional?
- should `sh` be a thin wrapper around Bun `$`, or a similar but runtime-owned primitive?
- how much non-shell runtime surface is needed early, such as `sleep` or `log`?
