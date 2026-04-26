# MCP connector (`apps/mcp`)

A [Model Context Protocol](https://modelcontextprotocol.io) server that lets
any compliant MCP client — Claude mobile/desktop, Cursor, VS Code, etc. —
call tools against the red system.

## URL & transport

| | |
|---|---|
| Endpoint | `https://red.computer/mcp` (prod) / `https://pr-<N>.preview.red.computer/mcp` (preview) |
| Transport | [Streamable HTTP](https://spec.modelcontextprotocol.io/specification/2025-03-26/basic/transports/#streamable-http) |
| Stateless? | Yes. Each `POST /mcp` is self-contained; no session IDs. |
| Auth | OAuth 2.1 Bearer tokens, introspected by `apps/auth` |
| Health | The service itself exposes `GET /health`; the public gateway does not currently publish a dedicated `/mcp/health` route |

Path-based routing in `infra/platform/gateway/envoy.yaml.template` sends any request
matching `/mcp*` to the `red_mcp` cluster (`${MCP_HOST}:3002`). TLS is
terminated one hop above by the production Caddy / preview Caddy.

## Auth flow (multi-client)

```
Client (Claude mobile/desktop, Cursor, ...)
    │
    │ 1. Authorization Code + PKCE against apps/auth
    │    scope=mcp:read (add mcp:write later)
    ▼
apps/auth  /oauth/authorize, /oauth/token
    │
    │ 2. Client gets access_token
    ▼
MCP JSON-RPC requests carry Authorization: Bearer <token>
    │
    ▼
apps/mcp  (Hono middleware)
    │
    │ 3. POST /oauth/introspect  (HTTP Basic with MCP service client_id/secret)
    ▼
apps/auth  returns { active, scope, sub, exp }
    │
    ▼
apps/mcp caches the introspection result until `exp` or 60 s, whichever sooner
```

Scope `mcp:read` gates the current tool surface. When write tools ship, the
server will also require `mcp:write`.

## Registering clients

**MCP server's own client** (for token introspection):

```bash
# One-time: create an OAuth client in apps/auth for the MCP service itself.
# Set the resulting client_id / client_secret in .env.production:
#   MCP_OAUTH_CLIENT_ID=mcp-service
#   MCP_OAUTH_CLIENT_SECRET=...
```

**User-facing clients** (Claude mobile, Claude desktop, Cursor, …):

Each client registers once via OAuth dynamic client registration, or the
maintainer pre-creates static clients in apps/auth:

| client_id | description | scope |
|---|---|---|
| `mcp-claude-mobile` | Claude iOS/Android app | `mcp:read` |
| `mcp-claude-desktop` | Claude desktop app | `mcp:read` |
| `mcp-cursor` | Cursor IDE | `mcp:read` |

The connector UX in each client handles the authorization code exchange;
users see `red.computer` in the consent screen and approve.

## Adding a tool

All tools live in `apps/mcp/src/tools/`. The boilerplate ships one `ping`
tool as a smoke test. Adding a new tool is three steps:

1. Create `apps/mcp/src/tools/list-repos.ts`:
   ```ts
   import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
   import { z } from "zod";

   export function registerListRepos(server: McpServer): void {
     server.registerTool(
       "list_repos",
       {
         title: "List repos",
         description: "Every repo tracked by the red control plane.",
         inputSchema: { limit: z.number().int().min(1).max(100).default(20) },
       },
       async ({ limit }) => {
         const res = await fetch(`${process.env.REDC_API_BASE_URL}/api/repos`);
         const body = await res.json();
         return {
           content: [{ type: "text", text: JSON.stringify(body.slice(0, limit), null, 2) }],
         };
       },
     );
   }
   ```
2. Import + call from `apps/mcp/src/tools/index.ts`:
   ```ts
   import { registerListRepos } from "./list-repos";
   export function registerTools(server) {
     // ...existing
     registerListRepos(server);
   }
   ```
3. Add unit test (mock the downstream service) + restart `just triage-up`-style
   if running in compose.

## Local testing

The MCP spec doesn't dictate how you _exercise_ a server. Two paths:

1. **Inspector** (no real client):
   ```bash
   bunx @modelcontextprotocol/inspector apps/mcp/src/index.ts
   ```
   Opens a web UI where you can invoke every tool with typed inputs.

2. **Real client via tunnel**. Run the server locally with `MCP_DISABLE_AUTH=true`
   (already the default in `.env.development`), expose it via
   `cloudflared tunnel --url http://localhost:3002`, and point Claude
   mobile's MCP connector at `https://<cf-tunnel>.trycloudflare.com/mcp`.

## Env vars

| var | purpose | default |
|---|---|---|
| `MCP_PORT` | listen port | `3002` |
| `MCP_AUTH_BASE_URL` | apps/auth origin for introspection | required |
| `MCP_OAUTH_CLIENT_ID` | this service's own OAuth client id | required |
| `MCP_OAUTH_CLIENT_SECRET` | this service's own OAuth client secret | required |
| `MCP_REQUIRED_SCOPE` | scope every inbound token must have | `mcp:read` |
| `MCP_DISABLE_AUTH` | dev-only bypass of introspection | `false` |
| `GIT_COMMIT` | populated by Dockerfile ARG or deploy env | `unknown` |

All production values land in `.env.production` (encrypted via dotenvx).

## Operational checks

- Direct service health: `curl http://localhost:3002/health` in local dev, or
  `docker compose ... exec mcp curl -fsS http://127.0.0.1:3002/health` inside
  a compose stack
- Public gateway smoke: `curl -i https://red.computer/mcp` should reach the MCP
  endpoint (it will still reject malformed or unauthorized requests)
- `service-health` CI already covers every service's `/health` contract;
  MCP is in the rotation via `apps/mcp/src/health-contract.test.ts`.
