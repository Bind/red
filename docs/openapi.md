# OpenAPI

Every redc HTTP service exposes an OpenAPI 3.1 spec at `/openapi.json` and
a browsable Scalar API reference at `/docs`. The **bff** stitches every
service's spec into a combined document served at `/rpc/openapi.json`;
envoy rewrites that to the public path `/api/openapi.json` with the
reference UI at `/api/docs`.

## Reading the specs

| URL | what you get |
|---|---|
| `https://red.computer/api/docs` | Scalar UI over the combined spec |
| `https://red.computer/api/openapi.json` | All services' paths, prefix-namespaced |
| `https://red.computer/health` | ctl's `/health` (proxied by envoy) |
| `http://<service-host>/docs` | Per-service Scalar UI (dev only) |
| `http://<service-host>/openapi.json` | Per-service spec |

Path namespacing in the combined doc: `/api/*` → ctl, `/auth/*` → auth,
`/rpc/*` → bff, `/obs/*` → obs, `/triage/*` → triage, `/mcp/*` → mcp.

## Coverage today

| service | createService | `createRoute()` coverage |
|---|---|---|
| **obs** | ✅ | ✅ all 4 routes typed (rollups list / get / stats, event ingest) |
| **mcp** | ✅ | ✅ `POST /mcp` typed |
| **triage** | ✅ shell | ❌ routes not yet typed — Zod v4 (Smithers) blocks `@hono/zod-openapi` v3 today |
| **auth** | ✅ shell via `mountDocs()` | ❌ incremental — port routes as they're touched |
| **bff** | ✅ shell via `mountDocs()` | ❌ incremental |
| **ctl** | ✅ shell via `mountDocs()` | ❌ incremental |

"Shell" means the service has `/openapi.json` + `/docs` endpoints backed
by `@hono/zod-openapi`, but the existing route handlers still use the
old `app.get()` / `app.post()` style and don't appear in the spec. The
combined spec aggregator still picks them up — they just show up with
no schema bodies.

## Adding a typed route

```ts
import { createRoute, z } from "@redc/server";

app.openapi(
  createRoute({
    method: "get",
    path: "/api/velocity",
    tags: ["reports"],
    summary: "Merge velocity over the last N hours",
    request: {
      query: z.object({ hours: z.string().optional() }),
    },
    responses: {
      200: {
        description: "Velocity snapshot",
        content: {
          "application/json": { schema: VelocitySchema.openapi("Velocity") },
        },
      },
    },
  }),
  async (c) => {
    const { hours } = c.req.valid("query");
    return c.json(await getVelocity(hours), 200);
  },
);
```

Schemas defined with `.openapi("Name")` appear under `components.schemas`
in the generated doc — Scalar renders them as reusable types.

## Zod-v4 limitation

`@hono/zod-openapi@0.19` uses `@asteasolutions/zod-to-openapi` which
tracks Zod v3. `apps/triage` pulls in Zod v4 transitively via
`smithers-orchestrator`; its route schemas can't feed `createRoute()`
until the upstream tooling catches up. Options when we revisit:

1. Wait for `@hono/zod-openapi` to publish a v4-compatible release
2. Re-declare triage's route schemas against v3 locally (parallel to
   the v4 Smithers schemas)
3. Switch triage's HTTP API away from Zod and use plain TS types for
   the OpenAPI side

Tracked — not urgent, triage's routes are internal-service-to-service.

## Adding a new service

1. `import { createService } from "@redc/server"` in the service's `app.ts`.
2. Replace `new Hono()` with `createService({ name, version, description })`.
3. Define routes with `createRoute()` + `app.openapi(...)`.
4. Register the service's prefix in the aggregator in `apps/bff/src/app.ts`:
   ```ts
   ...(config.newBaseUrl ? [{ name: "new", baseUrl: config.newBaseUrl, prefix: "/new" }] : []),
   ```
5. Add a matching envoy route in `infra/gateway/envoy.yaml.template` if the service is exposed publicly.

## Local dev

```bash
just up
open http://localhost:3001/rpc/docs         # unified Scalar UI
open http://localhost:4090/docs             # obs solo
curl http://localhost:3001/rpc/openapi.json # combined spec JSON
```
