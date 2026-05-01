import { describe, expect, test } from "bun:test";
import { createApp } from "./app";
import type { HostedRepoSnapshot } from "./hosted-repo";

describe("BFF app", () => {
  test("aggregates status across configured services", async () => {
    const app = createApp({
      port: 3001,
      apiBaseUrl: "http://api.test",
      authBaseUrl: "http://auth.test",
      obsBaseUrl: "http://obs.test",
      triageBaseUrl: "http://triage.test",
      grsBaseUrl: "http://grs.test",
      mcpBaseUrl: "http://mcp.test",
      fetchImpl: async (input) => {
        const request = input instanceof Request ? input : new Request(input);
        const url = new URL(request.url);
        if (url.pathname !== "/health") {
          return new Response("not found", { status: 404 });
        }
        switch (url.host) {
          case "api.test":
          case "auth.test":
          case "grs.test":
            return Response.json({ service: url.host.split(".")[0], status: "ok" });
          case "obs.test":
            return Response.json({ error: "duckdb unavailable" }, { status: 503 });
          case "triage.test":
            throw new Error("connect ECONNREFUSED");
          case "mcp.test":
            return Response.json({ service: "mcp", status: "ok" });
          default:
            return new Response("not found", { status: 404 });
        }
      },
    });

    const response = await app.request("http://bff.test/rpc/status", {
      headers: {
        "x-request-id": "status-probe-1",
      },
    });

    expect(response.status).toBe(503);
    const body = await response.json();
    expect(body.overall_status).toBe("degraded");
    expect(body.services).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          service: "bff",
          status: "ok",
          http_status: 200,
        }),
        expect.objectContaining({
          service: "api",
          status: "ok",
          http_status: 200,
        }),
        expect.objectContaining({
          service: "obs",
          status: "error",
          http_status: 503,
          error: "duckdb unavailable",
        }),
        expect.objectContaining({
          service: "triage",
          status: "error",
          http_status: null,
          error: "connect ECONNREFUSED",
        }),
        expect.objectContaining({
          service: "grs",
          status: "ok",
          http_status: 200,
        }),
        expect.objectContaining({
          service: "mcp",
          status: "ok",
          http_status: 200,
        }),
      ]),
    );
  });

  test("reports dependency-aware health", async () => {
    const app = createApp({
      port: 3001,
      apiBaseUrl: "http://api.test",
      authBaseUrl: "http://auth.test",
      fetchImpl: async (input) => {
        const request = input instanceof Request ? input : new Request(input);
        const url = new URL(request.url);
        if (url.pathname === "/health" && url.host === "auth.test") {
          return Response.json({ status: "ok" });
        }
        if (url.pathname === "/health" && url.host === "api.test") {
          return Response.json({ status: "ok" });
        }
        return new Response("not found", { status: 404 });
      },
    });

    const response = await app.request("http://bff.test/health", {
      headers: {
        "x-request-id": "bff-health-request",
      },
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("x-request-id")).toBe("bff-health-request");
    expect(await response.json()).toMatchObject({
      status: "ok",
      service: "bff",
      checks: {
        auth: { status: "ok", upstream: "http://auth.test" },
        api: { status: "ok", upstream: "http://api.test" },
      },
    });
  });

  test("proxies JSON and text routes through RPC", async () => {
    let hostedRepoCommitDiffRequestId: string | null = null;

    const app = createApp({
      port: 3001,
      apiBaseUrl: "http://api.test",
      authBaseUrl: "http://auth.test",
      fetchImpl: async (input, init) => {
        const request = input instanceof Request ? input : new Request(input, init);
        const url = new URL(request.url);
        if (url.pathname === "/session/exchange") {
          return Response.json({
            access_token: "user-token",
            token_type: "Bearer",
            expires_in: 600,
            scope: "session:exchange repos:read repos:create changes:read",
            audience: "red-api",
            subject: "user:123",
            sid: "session-123",
          });
        }
        if (url.pathname === "/api/velocity") {
          return Response.json({ summarized: 3, pending_review: 1 });
        }
        if (url.pathname === "/api/changes/42/diff") {
          return new Response("diff --git a/README.md b/README.md\n", {
            headers: { "Content-Type": "text/plain; charset=utf-8" },
          });
        }
        if (url.pathname === "/api/repos/red/red/commits/abc123/diff") {
          hostedRepoCommitDiffRequestId = request.headers.get("x-request-id");
          return new Response("diff --git a/src/app.ts b/src/app.ts\n", {
            headers: { "Content-Type": "text/plain; charset=utf-8" },
          });
        }
        return new Response("not found", { status: 404 });
      },
      hostedRepo: {
        repoId: "red/red",
        apiBaseUrl: "http://api.test",
        readmePath: "README.md",
      },
    });

    const velocity = await app.request("http://bff.test/rpc/velocity");
    expect(velocity.status).toBe(200);
    expect(await velocity.json()).toEqual({ summarized: 3, pending_review: 1 });

    const diff = await app.request("http://bff.test/rpc/changes/42/diff");
    expect(diff.status).toBe(200);
    expect(await diff.text()).toContain("diff --git");

    const commitDiff = await app.request("http://bff.test/rpc/app/hosted-repo/commits/abc123/diff", {
      headers: {
        "x-request-id": "hosted-repo-commit-diff-1",
      },
    });
    expect(commitDiff.status).toBe(200);
    expect(await commitDiff.text()).toContain("diff --git");
    expect(String(hostedRepoCommitDiffRequestId)).toBe("hosted-repo-commit-diff-1");
  });

  test("exposes the auth session through /rpc/me", async () => {
    const app = createApp({
      port: 3001,
      apiBaseUrl: "http://api.test",
      authBaseUrl: "http://auth.test",
      fetchImpl: async (input) => {
        const request = input instanceof Request ? input : new Request(input);
        const url = new URL(request.url);
        if (url.pathname === "/me") {
          return Response.json({
            session: { id: "session-123" },
            user: { email: "user@example.com", onboardingState: "active" },
          });
        }
        return new Response("not found", { status: 404 });
      },
    });

    const response = await app.request("http://bff.test/rpc/me", {
      headers: { Cookie: "better-auth.session_token=abc" },
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      session: { id: "session-123" },
      user: { email: "user@example.com", onboardingState: "active" },
    });
  });

  test("forwards request ids to upstream auth routes", async () => {
    const app = createApp({
      port: 3001,
      apiBaseUrl: "http://api.test",
      authBaseUrl: "http://auth.test",
      fetchImpl: async (input, init) => {
        const request = input instanceof Request ? input : new Request(input, init);
        const url = new URL(request.url);
        if (url.pathname === "/me") {
          expect(request.headers.get("x-request-id")).toBe("req-forward-1");
          return Response.json({
            session: { id: "session-123" },
            user: { email: "user@example.com", onboardingState: "active" },
          });
        }
        return new Response("not found", { status: 404 });
      },
    });

    const response = await app.request("http://bff.test/rpc/me", {
      headers: {
        "x-request-id": "req-forward-1",
      },
    });

    expect(response.status).toBe(200);
  });

  test("generates and forwards request ids when the client does not supply one", async () => {
    let forwardedRequestId: string | null = null;

    const app = createApp({
      port: 3001,
      apiBaseUrl: "http://api.test",
      authBaseUrl: "http://auth.test",
      fetchImpl: async (input, init) => {
        const request = input instanceof Request ? input : new Request(input, init);
        const url = new URL(request.url);
        if (url.pathname === "/me") {
          forwardedRequestId = request.headers.get("x-request-id");
          return Response.json({
            session: { id: "session-123" },
            user: { email: "user@example.com", onboardingState: "active" },
          });
        }
        return new Response("not found", { status: 404 });
      },
    });

    const response = await app.request("http://bff.test/rpc/me");

    expect(response.status).toBe(200);
    expect(forwardedRequestId).toBeTruthy();
    expect(response.headers.get("x-request-id")).toBe(forwardedRequestId);
  });

  test("exposes the latest dev mailbox magic link through /rpc/dev/magic-link", async () => {
    const app = createApp({
      port: 3001,
      apiBaseUrl: "http://api.test",
      authBaseUrl: "http://auth.test",
      fetchImpl: async (input) => {
        const request = input instanceof Request ? input : new Request(input);
        const url = new URL(request.url);
        if (url.pathname === "/__test__/mailbox/latest") {
          expect(url.searchParams.get("email")).toBe("user@example.com");
          return Response.json({
            email: "user@example.com",
            token: "mailbox-token",
            url: "http://localhost:4020/api/auth/verify?token=mailbox-token",
            purpose: "bootstrap",
          });
        }
        return new Response("not found", { status: 404 });
      },
    });

    const response = await app.request("http://bff.test/rpc/dev/magic-link?email=user@example.com");

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      email: "user@example.com",
      token: "mailbox-token",
      url: "http://localhost:4020/api/auth/verify?token=mailbox-token",
      purpose: "bootstrap",
    });
  });

  test("proxies login attempt creation and redemption through auth routes", async () => {
    const app = createApp({
      port: 3001,
      apiBaseUrl: "http://api.test",
      authBaseUrl: "http://auth.test",
      fetchImpl: async (input, init) => {
        const request = input instanceof Request ? input : new Request(input, init);
        const url = new URL(request.url);
        if (url.pathname === "/login-attempts" && request.method === "POST") {
          return Response.json({
            attempt_id: "attempt-123",
            status: "pending",
            client_id: "red-web",
          });
        }
        if (url.pathname === "/login-attempts/redeem" && request.method === "POST") {
          return new Response(
            JSON.stringify({
              ok: true,
              status: "redeemed",
              attempt_id: "attempt-123",
            }),
            {
              status: 200,
              headers: {
                "content-type": "application/json",
                "set-cookie": "better-auth.session_token=abc; Path=/; HttpOnly",
              },
            },
          );
        }
        return new Response("not found", { status: 404 });
      },
    });

    const createResponse = await app.request("http://bff.test/rpc/auth/login-attempts", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "user@example.com", client_id: "red-web" }),
    });
    expect(createResponse.status).toBe(200);
    expect(await createResponse.json()).toEqual({
      attempt_id: "attempt-123",
      status: "pending",
      client_id: "red-web",
    });

    const redeemResponse = await app.request("http://bff.test/rpc/auth/login-attempts/redeem", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ attempt_id: "attempt-123", login_grant: "grant-123" }),
    });
    expect(redeemResponse.status).toBe(200);
    expect(redeemResponse.headers.get("set-cookie")).toContain("better-auth.session_token=abc");
    expect(await redeemResponse.json()).toEqual({
      ok: true,
      status: "redeemed",
      attempt_id: "attempt-123",
    });
  });

  test("proxies onboarding routes through auth and preserves cookies", async () => {
    const app = createApp({
      port: 3001,
      apiBaseUrl: "http://api.test",
      authBaseUrl: "http://auth.test",
      fetchImpl: async (input, init) => {
        const request = input instanceof Request ? input : new Request(input, init);
        const url = new URL(request.url);
        if (url.pathname === "/user/two-factor/enroll") {
          return Response.json({
            totpURI: "otpauth://totp/red?secret=SECRET",
            backupCodes: ["CODE-1", "CODE-2"],
          });
        }
        if (url.pathname === "/user/two-factor/verify") {
          return new Response(
            JSON.stringify({
              sessionKind: "active",
              secondFactorVerified: true,
            }),
            {
              headers: {
                "content-type": "application/json",
                "set-cookie": "better-auth.session_token=verified; Path=/; HttpOnly",
              },
            },
          );
        }
        if (url.pathname === "/user/onboarding/complete") {
          return Response.json({ ok: true });
        }
        return new Response("not found", { status: 404 });
      },
    });

    const enrollResponse = await app.request("http://bff.test/rpc/auth/user/two-factor/enroll", {
      method: "POST",
      headers: { Cookie: "better-auth.session_token=abc" },
    });
    expect(enrollResponse.status).toBe(200);
    expect(await enrollResponse.json()).toEqual({
      totpURI: "otpauth://totp/red?secret=SECRET",
      backupCodes: ["CODE-1", "CODE-2"],
    });

    const verifyResponse = await app.request("http://bff.test/rpc/auth/user/two-factor/verify", {
      method: "POST",
      headers: {
        Cookie: "better-auth.session_token=abc",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ code: "123456" }),
    });
    expect(verifyResponse.status).toBe(200);
    expect(verifyResponse.headers.get("set-cookie")).toContain("better-auth.session_token=verified");

    const completeResponse = await app.request("http://bff.test/rpc/auth/user/onboarding/complete", {
      method: "POST",
      headers: { Cookie: "better-auth.session_token=verified" },
    });
    expect(completeResponse.status).toBe(200);
    expect(await completeResponse.json()).toEqual({ ok: true });
  });

  test("exchanges the auth session and forwards a bearer token to the API", async () => {
    const calls: Array<{ path: string; authorization: string | null; cookie: string | null }> = [];
    const app = createApp({
      port: 3001,
      apiBaseUrl: "http://api.test",
      authBaseUrl: "http://auth.test",
      fetchImpl: async (input, init) => {
        const request = input instanceof Request ? input : new Request(input, init);
        const url = new URL(request.url);
        calls.push({
          path: url.pathname,
          authorization: request.headers.get("authorization"),
          cookie: request.headers.get("cookie"),
        });

        if (url.pathname === "/session/exchange") {
          return Response.json({
            access_token: "user-token",
            token_type: "Bearer",
            expires_in: 600,
            scope: "session:exchange repos:read repos:create changes:read",
            audience: "red-api",
            subject: "user:123",
            sid: "session-123",
          });
        }

        if (url.pathname === "/api/review") {
          return Response.json([{ id: 1, repo: "owner/repo" }]);
        }

        return new Response("not found", { status: 404 });
      },
    });

    const response = await app.request("http://bff.test/rpc/review", {
      headers: { Cookie: "better-auth.session_token=abc" },
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual([{ id: 1, repo: "owner/repo" }]);
    expect(calls.map((call) => call.path)).toEqual(["/session/exchange", "/api/review"]);
    expect(calls[0]?.cookie).toBe("better-auth.session_token=abc");
    expect(calls[1]?.authorization).toBe("Bearer user-token");
    expect(calls[1]?.cookie).toBe("better-auth.session_token=abc");
  });

  test("proxies repo creation through the session exchange flow", async () => {
    const calls: Array<{
      path: string;
      method: string;
      authorization: string | null;
      cookie: string | null;
      body: string | null;
    }> = [];
    const app = createApp({
      port: 3001,
      apiBaseUrl: "http://api.test",
      authBaseUrl: "http://auth.test",
      fetchImpl: async (input, init) => {
        const request = input instanceof Request ? input : new Request(input, init);
        const url = new URL(request.url);
        calls.push({
          path: url.pathname,
          method: request.method,
          authorization: request.headers.get("authorization"),
          cookie: request.headers.get("cookie"),
          body: request.method === "GET" || request.method === "HEAD" ? null : await request.text(),
        });

        if (url.pathname === "/session/exchange") {
          return Response.json({
            access_token: "user-token",
            token_type: "Bearer",
            expires_in: 600,
            scope: "session:exchange repos:read repos:create changes:read",
            audience: "red-api",
            subject: "user:123",
            sid: "session-123",
          });
        }

        if (url.pathname === "/api/repos") {
          return Response.json(
            {
              id: 1,
              owner: "red",
              name: "dashboard-demo",
              full_name: "red/dashboard-demo",
              default_branch: "main",
              visibility: "private",
            },
            { status: 201 },
          );
        }

        return new Response("not found", { status: 404 });
      },
    });

    const response = await app.request("http://bff.test/rpc/repos", {
      method: "POST",
      headers: {
        Cookie: "better-auth.session_token=abc",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        owner: "red",
        name: "dashboard-demo",
        default_branch: "main",
        visibility: "private",
      }),
    });

    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({
      id: 1,
      owner: "red",
      name: "dashboard-demo",
      full_name: "red/dashboard-demo",
      default_branch: "main",
      visibility: "private",
    });
    expect(calls.map((call) => [call.method, call.path])).toEqual([
      ["POST", "/session/exchange"],
      ["POST", "/api/repos"],
    ]);
    expect(calls[1]?.authorization).toBe("Bearer user-token");
    expect(calls[1]?.cookie).toBe("better-auth.session_token=abc");
    expect(calls[1]?.body).toBe(
      JSON.stringify({
        owner: "red",
        name: "dashboard-demo",
        default_branch: "main",
        visibility: "private",
      }),
    );
  });

  test("proxies auth routes and preserves cookies", async () => {
    const app = createApp({
      port: 3001,
      apiBaseUrl: "http://api.test",
      authBaseUrl: "http://auth.test",
      fetchImpl: async () =>
        new Response(JSON.stringify({ ok: true }), {
          headers: {
            "Content-Type": "application/json",
            "Set-Cookie": "session=abc; Path=/; HttpOnly",
          },
        }),
    });

    const response = await app.request("http://bff.test/api/auth/session", {
      method: "GET",
      headers: { Cookie: "session=abc" },
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("set-cookie")).toContain("session=abc");
  });

  test("serves the special hosted repo snapshot from the BFF-owned reader", async () => {
    const snapshot: HostedRepoSnapshot = {
      repo: {
        owner: "red",
        name: "red",
        full_name: "red/red",
        default_branch: "main",
        visibility: "private",
      },
      readme: {
        path: "README.md",
        content: "# red\n",
      },
      branches: [
        {
          name: "main",
          sha: "abc123",
          message: "bootstrap hosted repo",
          timestamp: "2026-04-05T00:00:00.000Z",
          protected: true,
        },
      ],
      commits: [
        {
          sha: "abc123",
          message: "bootstrap hosted repo",
          author_name: "red",
          author_email: "team@red.local",
          timestamp: "2026-04-05T00:00:00.000Z",
        },
      ],
      access: {
        actor_id: "red-bff-hosted-repo",
        mode: "read",
        token_ttl_seconds: 300,
      },
      availability: {
        reachable: true,
        error: null,
      },
      fetched_at: "2026-04-05T00:00:00.000Z",
    };

    const app = createApp({
      port: 3001,
      apiBaseUrl: "http://api.test",
      authBaseUrl: "http://auth.test",
      hostedRepoReader: {
        readSnapshot: async () => snapshot,
      },
    });

    const response = await app.request("http://bff.test/rpc/app/hosted-repo");

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(snapshot);
  });
});
