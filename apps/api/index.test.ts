import { describe, test, expect } from "bun:test";
import { createApp, type AppConfig } from "./index";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const testConfig: AppConfig = {
  port: 0,
  dbPath: ":memory:",
  repoBackend: {
    kind: "git_storage",
    publicUrl: "http://git-server.test",
    defaultOwner: "redc",
    defaultBranch: "main",
  },
  repos: [],
  artifacts: {
    minio: {
      endPoint: "localhost",
      port: 9000,
      useSSL: false,
      accessKey: "minioadmin",
      secretKey: "minioadmin",
      bucket: "test-artifacts",
      prefix: "claw-runs",
    },
  },
};

describe("App integration", () => {
  test("health endpoint returns ok", async () => {
    const { app } = createApp(testConfig);
    const res = await app.fetch(
      new Request("http://localhost/health", {
        headers: {
          "x-request-id": "api-health-request",
        },
      }),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("x-request-id")).toBe("api-health-request");
    const json = await res.json();
    expect(json.status).toBe("ok");
  });

  test("velocity endpoint returns counts", async () => {
    const { app } = createApp(testConfig);
    const res = await app.fetch(new Request("http://localhost/api/velocity"));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.summarized).toBe(0);
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

  test("repo listing is durable and repo creation persists across app instances", async () => {
    const dir = await mkdtemp(join(tmpdir(), "redc-repos-"));
    const dbPath = join(dir, "repos.db");

    const first = createApp({ ...testConfig, dbPath });

    const createResponse = await first.app.fetch(new Request("http://localhost/api/repos", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        owner: "redc",
        name: "dashboard-demo",
        default_branch: "main",
        visibility: "private",
      }),
    }));
    expect(createResponse.status).toBe(201);
    const created = await createResponse.json() as {
      full_name: string;
      default_branch: string;
      visibility: string;
    };
    expect(created.full_name).toBe("redc/dashboard-demo");
    expect(created.default_branch).toBe("main");

    const listResponse = await first.app.fetch(new Request("http://localhost/api/repos"));
    expect(listResponse.status).toBe(200);
    expect(await listResponse.json()).toEqual(["redc/dashboard-demo"]);

    first.db.close();

    const second = createApp({ ...testConfig, dbPath });
    const secondListResponse = await second.app.fetch(new Request("http://localhost/api/repos"));
    expect(secondListResponse.status).toBe(200);
    expect(await secondListResponse.json()).toEqual(["redc/dashboard-demo"]);

    const repo = await second.repositoryProvider.getRepo?.("redc", "dashboard-demo");
    expect(repo).not.toBeNull();
    expect(repo).toMatchObject({
      full_name: "redc/dashboard-demo",
      default_branch: "main",
    });

    second.db.close();
  });

  test("claw actions endpoint returns action metadata", async () => {
    const { app } = createApp(testConfig);
    const res = await app.fetch(new Request("http://localhost/api/claw/actions"));
    expect(res.status).toBe(200);
    const json = await res.json() as Array<{ id: string; promptHash: string }>;
    expect(json.some((action) => action.id === "generate-summary")).toBe(true);
    expect(json.every((action) => action.promptHash.length > 0)).toBe(true);
  });

  test("claw prompt endpoint returns prompt details", async () => {
    const { app } = createApp(testConfig);
    const res = await app.fetch(new Request("http://localhost/api/claw/actions/generate-summary/prompt"));
    expect(res.status).toBe(200);
    const json = await res.json() as { id: string; prompt: string; promptHash: string };
    expect(json.id).toBe("generate-summary");
    expect(json.prompt).toContain('You are reviewing a change on branch "{{branch}}"');
    expect(json.promptHash.length).toBeGreaterThan(0);
  });

  test("claw runs endpoint returns a list", async () => {
    const { app } = createApp(testConfig);
    const res = await app.fetch(new Request("http://localhost/api/claw/runs"));
    expect(res.status).toBe(200);
    const json = await res.json() as unknown[];
    expect(Array.isArray(json)).toBe(true);
  });

  test("missing claw run returns 404", async () => {
    const { app } = createApp(testConfig);
    const res = await app.fetch(new Request("http://localhost/api/claw/runs/missing-run"));
    expect(res.status).toBe(404);
  });

  test("missing claw artifact returns 404", async () => {
    const { app } = createApp(testConfig);
    const res = await app.fetch(new Request("http://localhost/api/claw/runs/missing-run/artifacts/result"));
    expect(res.status).toBe(404);
  });

  test("createApp with file-based db", async () => {
    const dir = await mkdtemp(join(tmpdir(), "redc-test-"));
    const { app, db } = createApp({ ...testConfig, dbPath: join(dir, "test.db") });
    const res = await app.fetch(new Request("http://localhost/health"));
    expect(res.status).toBe(200);
    db.close();
  });

  test("requeue summary enqueues a generate_summary job from scored", async () => {
    const { app, changes, jobs, db } = createApp(testConfig);
    const change = changes.create({
      org_id: "default",
      repo: "redc-admin/test-repo",
      branch: "feature/test",
      base_branch: "main",
      head_sha: "abc123",
      created_by: "human",
      delivery_id: "delivery-1",
      diff_stats: JSON.stringify({ files_changed: 1, additions: 1, deletions: 0, files: ["test-file.txt"] }),
    });
    changes.updateStatus(change.id, "scored");

    const res = await app.fetch(new Request(`http://localhost/api/changes/${change.id}/requeue-summary`, {
      method: "POST",
    }));

    expect(res.status).toBe(200);
    expect(changes.getById(change.id)?.status).toBe("summarizing");
    const pending = jobs.claimNext("generate_summary");
    expect(pending).not.toBeNull();
    expect(JSON.parse(pending!.payload).change_id).toBe(change.id);
    db.close();
  });

  test("requeue summary rejects non-scored changes", async () => {
    const { app, changes, db } = createApp(testConfig);
    const change = changes.create({
      org_id: "default",
      repo: "redc-admin/test-repo",
      branch: "feature/test",
      base_branch: "main",
      head_sha: "abc123",
      created_by: "human",
      delivery_id: "delivery-2",
      diff_stats: JSON.stringify({ files_changed: 1, additions: 1, deletions: 0, files: ["test-file.txt"] }),
    });

    const res = await app.fetch(new Request(`http://localhost/api/changes/${change.id}/requeue-summary`, {
      method: "POST",
    }));

    expect(res.status).toBe(400);
    db.close();
  });

  test("local ref-update ingestion endpoint creates a change", async () => {
    const { app, changes } = createApp(testConfig);
    const res = await app.fetch(new Request("http://localhost/api/ingest/ref-update", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        repo: "owner/repo",
        branch: "feature/local",
        base_branch: "main",
        head_sha: "sha-local-1",
        created_by: "human",
      }),
    }));

    expect(res.status).toBe(201);
    const json = await res.json() as { status: string; change_id: number };
    expect(json.status).toBe("accepted");
    expect(changes.getById(json.change_id)?.branch).toBe("feature/local");
  });
});
