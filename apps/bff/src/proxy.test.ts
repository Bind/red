import { describe, expect, test } from "bun:test";
import { Hono } from "@red/server";
import { makeProxy, type ProxyConfig } from "./proxy";

type Call = {
  url: string;
  method: string;
  authorization: string | null;
  cookie: string | null;
  redirect: RequestRedirect | undefined;
  body: string | null;
};

function recorder(impl: (req: Request) => Promise<Response>) {
  const calls: Call[] = [];
  const fetchImpl = async (input: RequestInfo | URL | Request, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init);
    const body =
      request.method === "GET" || request.method === "HEAD" ? null : await request.clone().text();
    calls.push({
      url: request.url,
      method: request.method,
      authorization: request.headers.get("authorization"),
      cookie: request.headers.get("cookie"),
      redirect: init?.redirect,
      body,
    });
    return impl(request);
  };
  return { calls, fetchImpl };
}

function baseConfig(overrides: Partial<ProxyConfig> = {}): ProxyConfig {
  return {
    apiBaseUrl: "http://api.test",
    authBaseUrl: "http://auth.test",
    obsBaseUrl: "http://obs.test",
    triageBaseUrl: "http://triage.test",
    ...overrides,
  };
}

function exchangeOk(token = "tok-1") {
  return Response.json({ access_token: token, token_type: "Bearer", expires_in: 600 });
}

describe("proxy builder", () => {
  test("default jwt mode exchanges session and forwards Bearer to api", async () => {
    const { calls, fetchImpl } = recorder(async (req) => {
      const url = new URL(req.url);
      if (url.pathname === "/session/exchange") return exchangeOk();
      if (url.pathname === "/api/foo") return Response.json({ ok: true });
      return new Response("nf", { status: 404 });
    });
    const proxy = makeProxy({ config: baseConfig(), fetchImpl });
    const app = new Hono().get("/test", (c) => proxy(c).path("/api/foo").send());

    const res = await app.request("/test", { headers: { Cookie: "session=abc" } });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(calls.map((c) => c.url)).toEqual([
      "http://auth.test/session/exchange",
      "http://api.test/api/foo",
    ]);
    expect(calls[0]?.cookie).toBe("session=abc");
    expect(calls[1]?.authorization).toBe("Bearer tok-1");
    expect(calls[1]?.cookie).toBe("session=abc");
  });

  test("jwt exchange failure passes upstream auth response through", async () => {
    const { fetchImpl } = recorder(async (req) => {
      const url = new URL(req.url);
      if (url.pathname === "/session/exchange") {
        return new Response(JSON.stringify({ error: "no_session" }), {
          status: 401,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response("nf", { status: 404 });
    });
    const proxy = makeProxy({ config: baseConfig(), fetchImpl });
    const app = new Hono().get("/test", (c) => proxy(c).path("/api/foo").send());

    const res = await app.request("/test");

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "no_session" });
  });

  test("cookie auth uses redirect:manual and copies set-cookie", async () => {
    const { calls, fetchImpl } = recorder(async () =>
      new Response(JSON.stringify({ ok: true }), {
        headers: {
          "content-type": "application/json",
          "set-cookie": "session=new; Path=/; HttpOnly",
        },
      }),
    );
    const proxy = makeProxy({ config: baseConfig(), fetchImpl });
    const app = new Hono().get("/test", (c) =>
      proxy(c).to("auth").auth("cookie").as("stream").path("/whoami").send(),
    );

    const res = await app.request("/test", { headers: { Cookie: "session=abc" } });

    expect(res.status).toBe(200);
    expect(res.headers.get("set-cookie")).toContain("session=new");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("http://auth.test/whoami");
    expect(calls[0]?.redirect).toBe("manual");
    expect(calls[0]?.cookie).toBe("session=abc");
    expect(calls[0]?.authorization).toBeNull();
  });

  test("session auth gates without injecting Bearer", async () => {
    const { calls, fetchImpl } = recorder(async (req) => {
      const url = new URL(req.url);
      if (url.pathname === "/session/exchange") return exchangeOk();
      if (url.pathname === "/v1/daemons") return Response.json([{ name: "d1" }]);
      return new Response("nf", { status: 404 });
    });
    const proxy = makeProxy({ config: baseConfig(), fetchImpl });
    const app = new Hono().get("/test", (c) =>
      proxy(c).to("obs").auth("session").path("/v1/daemons").send(),
    );

    const res = await app.request("/test", { headers: { Cookie: "session=abc" } });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([{ name: "d1" }]);
    expect(calls.map((c) => c.url)).toEqual([
      "http://auth.test/session/exchange",
      "http://obs.test/v1/daemons",
    ]);
    expect(calls[1]?.authorization).toBeNull();
  });

  test("session auth bypassed when disableAuth is true", async () => {
    const { calls, fetchImpl } = recorder(async () => Response.json([]));
    const proxy = makeProxy({ config: baseConfig({ disableAuth: true }), fetchImpl });
    const app = new Hono().get("/test", (c) =>
      proxy(c).to("obs").auth("session").path("/v1/daemons").send(),
    );

    const res = await app.request("/test");

    expect(res.status).toBe(200);
    expect(calls.map((c) => c.url)).toEqual(["http://obs.test/v1/daemons"]);
  });

  test("none auth sends nothing extra and skips exchange", async () => {
    const { calls, fetchImpl } = recorder(async () => Response.json({ ok: true }));
    const proxy = makeProxy({ config: baseConfig(), fetchImpl });
    const app = new Hono().get("/test", (c) =>
      proxy(c).auth("none").path("/api/repos/x/y/tree").send(),
    );

    await app.request("/test");

    expect(calls.map((c) => c.url)).toEqual(["http://api.test/api/repos/x/y/tree"]);
    expect(calls[0]?.authorization).toBeNull();
  });

  test("503 when upstream is unconfigured, with shaped error body", async () => {
    const { calls, fetchImpl } = recorder(async () => Response.json({ ok: true }));
    const proxy = makeProxy({ config: baseConfig({ triageBaseUrl: undefined }), fetchImpl });
    const app = new Hono().get("/test", (c) =>
      proxy(c).to("triage").auth("none").path("/v1/runs").send(),
    );

    const res = await app.request("/test");

    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "triage backend not configured" });
    expect(calls).toHaveLength(0);
  });

  test("query allowlist plucks present params and ignores absent ones", async () => {
    const { calls, fetchImpl } = recorder(async () => Response.json([]));
    const proxy = makeProxy({ config: baseConfig({ disableAuth: true }), fetchImpl });
    const app = new Hono().get("/test", (c) =>
      proxy(c)
        .to("obs")
        .auth("session")
        .path("/v1/rollups")
        .query(["service", "outcome", "since", "limit"])
        .send(),
    );

    await app.request("/test?service=ctl&limit=5&unrelated=ignored");

    expect(calls).toHaveLength(1);
    const target = new URL(calls[0]!.url);
    expect(target.pathname).toBe("/v1/rollups");
    expect(target.searchParams.get("service")).toBe("ctl");
    expect(target.searchParams.get("limit")).toBe("5");
    expect(target.searchParams.has("outcome")).toBe(false);
    expect(target.searchParams.has("unrelated")).toBe(false);
  });

  test("queryAdd merges explicit values", async () => {
    const { calls, fetchImpl } = recorder(async () => Response.json([]));
    const proxy = makeProxy({ config: baseConfig({ disableAuth: true }), fetchImpl });
    const app = new Hono().get("/test", (c) =>
      proxy(c)
        .to("obs")
        .auth("session")
        .path("/v1/rollups")
        .queryAdd({ service: "ctl", outcome: undefined })
        .send(),
    );

    await app.request("/test");

    const target = new URL(calls[0]!.url);
    expect(target.searchParams.get("service")).toBe("ctl");
    expect(target.searchParams.has("outcome")).toBe(false);
  });

  test("text body mode preserves upstream content-type", async () => {
    const { fetchImpl } = recorder(async (req) => {
      const url = new URL(req.url);
      if (url.pathname === "/session/exchange") return exchangeOk();
      return new Response("diff --git a/x b/x\n", {
        headers: { "Content-Type": "text/x-diff; charset=utf-8" },
      });
    });
    const proxy = makeProxy({ config: baseConfig(), fetchImpl });
    const app = new Hono().get("/test", (c) =>
      proxy(c).path("/api/changes/1/diff").as("text").send(),
    );

    const res = await app.request("/test");

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/x-diff");
    expect(await res.text()).toContain("diff --git");
  });

  test("stream body mode passes body and select headers through", async () => {
    const { fetchImpl } = recorder(async (req) => {
      const url = new URL(req.url);
      if (url.pathname === "/session/exchange") return exchangeOk();
      return new Response("event: ping\ndata: 1\n\n", {
        headers: {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
          "x-strip-me": "should-be-stripped",
        },
      });
    });
    const proxy = makeProxy({ config: baseConfig(), fetchImpl });
    const app = new Hono().get("/test", (c) =>
      proxy(c).path("/api/changes/1/agent-events").as("stream").send(),
    );

    const res = await app.request("/test");

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/event-stream");
    expect(res.headers.get("cache-control")).toBe("no-cache");
    expect(res.headers.get("x-strip-me")).toBeNull();
    expect(await res.text()).toContain("event: ping");
  });

  test("onError returns fallback when upstream fetch throws", async () => {
    const fetchImpl = async (input: RequestInfo | URL | Request) => {
      const req = input instanceof Request ? input : new Request(input);
      const url = new URL(req.url);
      if (url.pathname === "/session/exchange") return exchangeOk();
      throw new Error("connect ECONNREFUSED");
    };
    const proxy = makeProxy({ config: baseConfig({ disableAuth: true }), fetchImpl });
    const app = new Hono().get("/test", (c) =>
      proxy(c)
        .to("triage")
        .auth("session")
        .path("/v1/runs")
        .onError(() => c.json({ runs: [] }))
        .send(),
    );

    const res = await app.request("/test");

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ runs: [] });
  });

  test("POST forwards the request body upstream after exchange", async () => {
    const { calls, fetchImpl } = recorder(async (req) => {
      const url = new URL(req.url);
      if (url.pathname === "/session/exchange") return exchangeOk();
      return Response.json({ id: 1 }, { status: 201 });
    });
    const proxy = makeProxy({ config: baseConfig(), fetchImpl });
    const app = new Hono().post("/test", (c) => proxy(c).path("/api/repos").send());

    const payload = { owner: "red", name: "demo" };
    const res = await app.request("/test", {
      method: "POST",
      headers: { Cookie: "session=abc", "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    expect(res.status).toBe(201);
    expect(calls.map((c) => [c.method, new URL(c.url).pathname])).toEqual([
      ["POST", "/session/exchange"],
      ["POST", "/api/repos"],
    ]);
    expect(calls[1]?.body).toBe(JSON.stringify(payload));
    expect(calls[1]?.authorization).toBe("Bearer tok-1");
  });
});
