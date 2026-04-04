import { describe, expect, test } from "bun:test";
import { createApp } from "./app";

describe("BFF app", () => {
  test("proxies JSON and text routes through RPC", async () => {
    const app = createApp({
      port: 3001,
      apiBaseUrl: "http://api.test",
      authBaseUrl: "http://auth.test",
      fetchImpl: async (input) => {
        const url = typeof input === "string" ? new URL(input) : new URL(input.url);
        if (url.pathname === "/api/velocity") {
          return Response.json({ summarized: 3, pending_review: 1 });
        }
        if (url.pathname === "/api/changes/42/diff") {
          return new Response("diff --git a/README.md b/README.md\n", {
            headers: { "Content-Type": "text/plain; charset=utf-8" },
          });
        }
        return new Response("not found", { status: 404 });
      },
    });

    const velocity = await app.request("http://bff.test/rpc/velocity");
    expect(velocity.status).toBe(200);
    expect(await velocity.json()).toEqual({ summarized: 3, pending_review: 1 });

    const diff = await app.request("http://bff.test/rpc/changes/42/diff");
    expect(diff.status).toBe(200);
    expect(await diff.text()).toContain("diff --git");
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
});
