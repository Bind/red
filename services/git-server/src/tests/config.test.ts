import { describe, expect, test } from "bun:test";

const requiredEnvNames = [
  "GIT_SERVER_PUBLIC_URL",
  "GIT_SERVER_PORT",
  "GIT_SERVER_S3_ENDPOINT",
  "GIT_SERVER_S3_REGION",
  "GIT_SERVER_S3_BUCKET",
  "GIT_SERVER_S3_PREFIX",
  "GIT_SERVER_S3_ACCESS_KEY_ID",
  "GIT_SERVER_S3_SECRET_ACCESS_KEY",
  "GIT_SERVER_ADMIN_USERNAME",
  "GIT_SERVER_ADMIN_PASSWORD",
  "GIT_SERVER_AUTH_TOKEN_SECRET",
];

describe("git server config", () => {
  test("server module fails fast when required env is missing", async () => {
    const script = [
      ...requiredEnvNames.map((name) => `delete process.env.${name};`),
      'await import("./src/core/minio-server.ts");',
    ].join("\n");

    const proc = Bun.spawn([process.execPath, "--eval", script], {
      cwd: import.meta.dir + "/../..",
      stdout: "pipe",
      stderr: "pipe",
      env: {},
    });

    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);

    expect(exitCode).not.toBe(0);
    expect(stdout).toBe("");
    expect(stderr).toContain("Missing required env var: GIT_SERVER_PUBLIC_URL");
  });
});
