# OpenTelemetry for Bun Server Boilerplate

## Current shape

Today the Bun HTTP services in this repo mostly follow the same pattern:

- `loadConfig()` in the app package
- `createApp()` returning a `Hono` app
- `Bun.serve()` in `src/index.ts`
- request-scoped events emitted via `@redc/obs`

Representative files:

- `apps/ctl/index.ts`
- `apps/auth/src/index.ts`
- `apps/bff/src/index.ts`
- `apps/mcp/src/index.ts`
- `apps/obs/src/index.ts`

Two important details from the current implementation:

1. `@redc/obs` is already the repo-wide request instrumentation layer.
   It creates a request envelope, tracks `x-request-id`, adds route/error metadata, and exports to console, file NDJSON, or the wide-events collector.
2. The server bootstrap is not centralized yet.
   Most apps repeat `loadConfig` + `createApp` + `Bun.serve`, and not all apps consistently install `obsMiddleware`.

That means OTEL fits best as a new shared bootstrap/package, not as one-off per-app wiring.

## What OTEL should do here

The practical goal is not "replace `@redc/obs`".
It is:

- standard traces for incoming HTTP requests
- trace propagation across internal service calls
- optional metrics export
- a stable bridge from OTEL span context into the existing wide-events schema

For this repo, that implies:

- `@redc/obs` stays the canonical application event envelope for now
- OTEL becomes the transport-neutral tracing layer underneath or alongside it
- `x-request-id` remains a first-class app concept even when `traceparent` is present

## Bun-specific constraints

Bun does not appear to offer first-class OTEL runtime docs today.
The realistic path is the JavaScript Node SDK running on Bun's Node-compat layer.

That is plausible because Bun documents `AsyncLocalStorage` support, but Bun also notes that V8 promise hooks are not called and that usage is discouraged. That is the main technical risk for OTEL context propagation on Bun.

Implication:

- manual instrumentation is low-risk
- full Node auto-instrumentation may be partially functional, but should not be assumed reliable without validation under this repo's actual traffic patterns

So the rollout should start with explicit manual spans around request handling and outbound `fetch`, not with "drop in auto-instrument everything".

## Recommended package shape

Add a new workspace package, for example `pkg/server`, and move shared server bootstrap concerns there.

Suggested responsibilities:

- OTEL SDK initialization and shutdown
- service resource metadata
- common env parsing for OTEL exporters
- request middleware that:
  - extracts incoming trace context
  - starts a server span
  - preserves or generates `x-request-id`
  - makes `requestId`, `traceId`, and `spanId` available to handlers
- wrapper for outbound `fetch` that injects trace context headers
- adapter that copies OTEL IDs into `@redc/obs` events

Minimal surface area:

```ts
export interface ServerObsOptions {
  serviceName: string;
  serviceVersion?: string;
  environment?: string;
}

export function initOtel(options: ServerObsOptions): Promise<void>;
export function shutdownOtel(): Promise<void>;
export function createObsMiddleware(options: {
  service: string;
  sink?: EventSink;
}): MiddlewareHandler;
export function instrumentedFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
```

`createObsMiddleware()` should remain compatible with the current `@redc/obs` model, but enrich events with:

- `trace.id`
- `span.id`
- `trace.sampled`

That lets wide-events correlate with OTEL backends without changing downstream consumers first.

## Rollout plan

### Phase 1: manual traces only

- Add OTEL SDK bootstrap with OTLP HTTP trace export only
- Start one server span per request in shared middleware
- Propagate trace headers on outbound `fetch`
- Copy `trace_id`/`span_id` into `@redc/obs`
- Keep metrics/logs out of scope

Apply first to:

- `apps/mcp`
- `apps/triage`

Reason:

- they are smaller than `ctl` and `auth`
- `triage` currently depends on `@redc/obs` but does not install the middleware
- both are a good proving ground for propagation and exporter configuration

### Phase 2: centralize server bootstrap

- Move repeated `Bun.serve()` setup into `pkg/server`
- Standardize startup/shutdown hooks
- Standardize health endpoint tracing behavior
- Migrate `bff`, `mcp`, `triage`, then `auth`, then `ctl`

### Phase 3: metrics if justified

Only add OTEL metrics after traces are stable.
Otherwise you will multiply complexity before proving context propagation works correctly on Bun.

Potential first metrics:

- request duration histogram
- request count by route/status
- upstream fetch duration histogram

### Phase 4: evaluate auto-instrumentation selectively

Only after Phase 1 is validated:

- test Node auto-instrumentation on Bun in one non-critical service
- verify context continuity through Hono handlers, timers, and internal `fetch`
- keep manual request middleware even if auto-instrumentation works

## Specific repo opportunities

Short-term fixes that OTEL work would naturally clean up:

- `apps/triage/src/index.ts` should likely install `@redc/obs` middleware before OTEL rollout so it matches the rest of the fleet
- `apps/mcp/src/index.ts` and `apps/triage/src/index.ts` are good candidates for the first shared bootstrap adoption
- `apps/ctl/index.ts`, `apps/auth/src/server.ts`, and `apps/bff/src/app.ts` already rely on `@redc/obs`, so they can consume OTEL through the adapter instead of rewriting handler logic

## Recommendation

Proceed, but keep the scope tight:

- do not replace `@redc/obs`
- do not start with zero-code auto-instrumentation
- do not try traces, metrics, and logs all at once

The right first milestone is:

1. shared OTEL bootstrap package
2. manual request spans
3. outbound trace propagation
4. bridge OTEL IDs into existing wide-events envelopes

If that works cleanly in `mcp` and `triage`, the rest of the Bun services can adopt it without changing their route code significantly.
