import { describe, expect, test } from "bun:test";
import { createJwksAuthServer } from "./jwks-server";

describe("jwks auth server", () => {
  test("serves jwks metadata", async () => {
    const server = await createJwksAuthServer({
      issuer: "http://127.0.0.1:4010",
      audience: "redc-jwks-lab",
      hostname: "127.0.0.1",
      port: 4010,
    });

    const response = await server.fetch(
      new Request("http://127.0.0.1:4010/.well-known/jwks.json")
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(Array.isArray(body.keys)).toBe(true);
    expect(body.keys[0]?.kid).toBe(server.kid);
  });

  test("issues tokens that authenticate against the protected route", async () => {
    const server = await createJwksAuthServer({
      issuer: "http://127.0.0.1:4010",
      audience: "redc-jwks-lab",
      hostname: "127.0.0.1",
      port: 4010,
    });

    const issued = await server.issueToken({ sub: "alice", scope: "read:changes" });
    const response = await server.fetch(
      new Request("http://127.0.0.1:4010/protected", {
        headers: {
          authorization: `Bearer ${issued.token}`,
        },
      })
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.ok).toBe(true);
    expect(body.subject).toBe("alice");
    expect(body.scope).toBe("read:changes");
  });

  test("rejects tokens with the wrong audience", async () => {
    const server = await createJwksAuthServer({
      issuer: "http://127.0.0.1:4010",
      audience: "redc-jwks-lab",
      hostname: "127.0.0.1",
      port: 4010,
    });

    const issued = await server.issueToken({ aud: "different-audience" });
    const response = await server.fetch(
      new Request("http://127.0.0.1:4010/protected", {
        headers: {
          authorization: `Bearer ${issued.token}`,
        },
      })
    );

    expect(response.status).toBe(401);
    const body = await response.json();
    expect(String(body.error)).toContain("unexpected \"aud\" claim value");
  });
});
