import { describe, test, expect } from "bun:test";
import { createApp, type AppConfig } from "./index";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const testConfig: AppConfig = {
  port: 0,
  dbPath: ":memory:",
  forgejo: {
    baseUrl: "http://localhost:3000",
    token: "test-token",
  },
  webhookSecret: "test-secret",
};

describe("App integration", () => {
  test("health endpoint returns ok", async () => {
    const { app } = createApp(testConfig);
    const res = await app.fetch(new Request("http://localhost/health"));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.status).toBe("ok");
  });

  test("velocity endpoint returns counts", async () => {
    const { app } = createApp(testConfig);
    const res = await app.fetch(new Request("http://localhost/api/velocity"));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.merged).toBe(0);
    expect(json.pending_review).toBe(0);
  });

  test("change detail returns 404 for nonexistent", async () => {
    const { app } = createApp(testConfig);
    const res = await app.fetch(new Request("http://localhost/api/changes/999"));
    expect(res.status).toBe(404);
  });

  test("review list returns empty initially", async () => {
    const { app } = createApp(testConfig);
    const res = await app.fetch(new Request("http://localhost/api/review"));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toEqual([]);
  });

  test("pending jobs returns zero initially", async () => {
    const { app } = createApp(testConfig);
    const res = await app.fetch(new Request("http://localhost/api/jobs/pending"));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.pending).toBe(0);
  });

  test("createApp with file-based db", async () => {
    const dir = await mkdtemp(join(tmpdir(), "redc-test-"));
    const { app, db } = createApp({ ...testConfig, dbPath: join(dir, "test.db") });
    const res = await app.fetch(new Request("http://localhost/health"));
    expect(res.status).toBe(200);
    db.close();
  });
});
