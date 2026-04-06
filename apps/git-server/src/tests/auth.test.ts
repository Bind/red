import { describe, expect, test } from "bun:test";
import { SharedSecretGitAuth } from "../core/auth";

describe("SharedSecretGitAuth", () => {
  test("issues credentials and authorizes matching repo access", () => {
    const auth = new SharedSecretGitAuth({
      adminUsername: "admin",
      adminPassword: "admin",
      tokenSecret: "secret",
    });

    const creds = auth.issueRepoCredentials({
      actorId: "agent-1",
      repoId: "redc/demo",
      access: "read",
      ttlSeconds: 60,
    });

    const header = `Basic ${Buffer.from(`${creds.username}:${creds.password}`).toString("base64")}`;
    const decision = auth.authorizeBasicAuth(header, {
      repoId: "redc/demo",
      requiredAccess: "read",
    });

    expect(decision.ok).toBe(true);
    if (decision.ok) {
      expect(decision.subject).toBe("agent-1");
      expect(decision.access).toBe("read");
    }
  });

  test("rejects repo mismatch", () => {
    const auth = new SharedSecretGitAuth({ tokenSecret: "secret" });
    const creds = auth.issueRepoCredentials({
      actorId: "agent-1",
      repoId: "redc/demo",
      access: "write",
      ttlSeconds: 60,
    });
    const header = `Basic ${Buffer.from(`${creds.username}:${creds.password}`).toString("base64")}`;

    const decision = auth.authorizeBasicAuth(header, {
      repoId: "redc/other",
      requiredAccess: "read",
    });

    expect(decision.ok).toBe(false);
    if (!decision.ok) {
      expect(decision.reason).toContain("redc/other");
    }
  });

  test("allows configured admin credentials", () => {
    const auth = new SharedSecretGitAuth({
      adminUsername: "admin",
      adminPassword: "admin",
    });
    const header = `Basic ${Buffer.from("admin:admin").toString("base64")}`;

    const decision = auth.authorizeBasicAuth(header, {
      repoId: "redc/demo",
      requiredAccess: "write",
    });

    expect(decision).toEqual({
      ok: true,
      subject: "admin",
      access: "admin",
    });
  });
});
