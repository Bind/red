# @red/server

Shared HTTP server framework helpers for `red` services. Re-exports `Hono`
and provides the standard request logger and server-logger configuration
used across every TS API in the monorepo.

## Convention: every TS Hono API exports an `AppRouter`

Each service that exposes an HTTP API must export an `AppRouter` type from
which a typed [`hc<AppRouter>`](https://hono.dev/docs/guides/rpc) client
can be constructed by callers.

The export is only useful if Hono can actually accumulate route info onto
the type. That requires **two** things:

1. **Routes are registered with chained syntax**, not statements.
2. **The chained value is captured** — its type, not the parent app, is
   the one exported as `AppRouter`.

### Pattern

Define the routes as a chained `Hono` returned from a factory that takes
a deps bag. Mount it on the outer app via `app.route(...)`. Export the
factory's return type.

```ts
// apps/<service>/api/router.ts
import { Hono } from "@red/server";

export interface ApiDeps {
  // queries, providers, state, ...
}

export function makeApiRouter(deps: ApiDeps) {
  return new Hono()
    .get("/api/foo", (c) => c.json({ ok: true }))
    .post("/api/bar", async (c) => c.json(await doBar(deps, await c.req.json())))
    .get("/api/baz/:id", (c) => c.json(deps.queries.getBaz(c.req.param("id"))));
}

export type AppRouter = ReturnType<typeof makeApiRouter>;
```

```ts
// apps/<service>/index.ts
import { Hono } from "@red/server";
import { makeApiRouter } from "./api/router";
export type { AppRouter } from "./api/router";

export function createApp(config: AppConfig) {
  // construct deps...
  const apiRouter = makeApiRouter(deps);

  const app = new Hono()
    .use("*", /* obs middleware */)
    .use("*", /* http logger */)
    .route("/", apiRouter);

  return { app, apiRouter, /* ... */ };
}
```

### What breaks the type if you get it wrong

- **Statement-style registration** (`app.get("/x", ...)` then ignore the
  return) loses the route info: `typeof app` does not gain `/x`.
- **Calling `app.route(...)` as a statement** discards the merged type
  the same way. Either chain it (`new Hono().use(...).route(...)`) or
  capture the assignment.
- **Exporting `ReturnType<typeof createApp>["app"]`** instead of
  `ReturnType<typeof makeApiRouter>` is fine *if* the chain at the top of
  `createApp` is preserved. Exporting `typeof apiRouter` is the simpler
  contract.

### Why a factory rather than a top-level `const`

The router needs request-scoped deps (DB queries, providers, state machines)
that are constructed inside `createApp` per process. A top-level chained
`const router = new Hono().get(...)` can't reach those without globals.
The factory takes the deps bag, returns the typed router, and lets
`createApp` decide how to wire it up.

### Should I extract a helper from `@red/server`?

Not yet. The pattern above is four lines per service. The skill rule
[*"two adapters means a real seam"*](https://github.com/mattpocock/skills/blob/main/skills/engineering/improve-codebase-architecture/DEEPENING.md)
applies — once we've migrated 3+ services and we're copy-pasting a real
amount of shared setup (middleware bundling, test harness, etc.), that's
the moment to extract a `defineApi(deps, builder)` helper. Today such a
helper would be ergonomic shrink-wrap for a 4-line idiom and would risk
locking the convention in a place where the call site is no longer
visible.

### Migration status

- [x] `apps/ctl`
- [x] `apps/bff`
- [x] `apps/auth`
- [ ] `apps/obs`
- [ ] `apps/triage`
- [ ] `apps/mcp`
- [ ] `apps/grs` (TS surface only)
