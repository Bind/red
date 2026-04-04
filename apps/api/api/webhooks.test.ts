import { describe, test, expect, beforeEach } from "bun:test";
import { initInMemoryDatabase } from "../db/schema";
import { ChangeQueries, EventQueries, JobQueries, DeliveryQueries } from "../db/queries";
import { ForgejoClient } from "../forgejo/client";
import { createWebhookRoutes, type WebhookDeps } from "./webhooks";
import type { ForgejoPushPayload } from "../types";
import type { Database } from "bun:sqlite";

const WEBHOOK_SECRET = "test-secret-123";

let db: Database;
let deps: WebhookDeps;

beforeEach(() => {
  db = initInMemoryDatabase();
  deps = {
    changes: new ChangeQueries(db),
    events: new EventQueries(db),
    deliveries: new DeliveryQueries(db),
    jobs: new JobQueries(db),
    forgejo: new ForgejoClient({ baseUrl: "http://localhost:3000", token: "test" }),
    webhookSecret: WEBHOOK_SECRET,
  };
});

function makePushPayload(overrides: Partial<ForgejoPushPayload> = {}): ForgejoPushPayload {
  return {
    ref: "refs/heads/feature-branch",
    before: "0000000000000000000000000000000000000000",
    after: "abc123def456",
    compare_url: "http://localhost/compare",
    commits: [
      {
        id: "abc123def456",
        message: "Add feature",
        author: { name: "Dev", email: "dev@example.com" },
        timestamp: new Date().toISOString(),
      },
    ],
    repository: {
      id: 1,
      name: "repo",
      full_name: "owner/repo",
      owner: { id: 1, login: "owner" },
      default_branch: "main",
    },
    sender: { id: 1, login: "owner" },
    ...overrides,
  };
}

async function signPayload(body: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
  return Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function postWebhook(
  app: ReturnType<typeof createWebhookRoutes>,
  payload: ForgejoPushPayload,
  opts: { deliveryId?: string; signature?: string; skipSign?: boolean } = {}
) {
  const body = JSON.stringify(payload);
  const signature = opts.signature ?? (opts.skipSign ? "" : await signPayload(body, WEBHOOK_SECRET));
  const deliveryId = opts.deliveryId ?? `del-${Math.random()}`;

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (signature) headers["X-Gitea-Signature"] = signature;
  if (deliveryId) headers["X-Gitea-Delivery"] = deliveryId;

  const req = new Request("http://localhost/webhook/push", {
    method: "POST",
    headers,
    body,
  });

  return app.fetch(req);
}

describe("Webhook handler", () => {
  test("accepts valid push and creates change", async () => {
    const app = createWebhookRoutes(deps);
    const payload = makePushPayload();
    const res = await postWebhook(app, payload);

    expect(res.status).toBe(201);
    const json = await res.json();
    expect(json.status).toBe("accepted");
    expect(json.change_id).toBeGreaterThan(0);

    // Verify change was created
    const change = deps.changes.getById(json.change_id);
    expect(change).not.toBeNull();
    expect(change!.repo).toBe("owner/repo");
    expect(change!.branch).toBe("feature-branch");
    expect(change!.status).toBe("pushed");
  });

  test("rejects missing signature", async () => {
    const app = createWebhookRoutes(deps);
    const payload = makePushPayload();
    const res = await postWebhook(app, payload, { skipSign: true });
    expect(res.status).toBe(401);
  });

  test("rejects invalid signature", async () => {
    const app = createWebhookRoutes(deps);
    const payload = makePushPayload();
    const res = await postWebhook(app, payload, { signature: "deadbeef" });
    expect(res.status).toBe(401);
  });

  test("deduplicates by delivery ID", async () => {
    const app = createWebhookRoutes(deps);
    const payload = makePushPayload();
    const deliveryId = "dup-test-1";

    const res1 = await postWebhook(app, payload, { deliveryId });
    expect(res1.status).toBe(201);

    const res2 = await postWebhook(app, payload, { deliveryId });
    expect(res2.status).toBe(200);
    const json2 = await res2.json();
    expect(json2.status).toBe("duplicate");
  });

  test("skips pushes to default branch", async () => {
    const app = createWebhookRoutes(deps);
    const payload = makePushPayload({ ref: "refs/heads/main" });
    const res = await postWebhook(app, payload);

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.status).toBe("skipped");
  });

  test("supersedes prior changes on same branch", async () => {
    const app = createWebhookRoutes(deps);

    const res1 = await postWebhook(app, makePushPayload({ after: "sha1" }), {
      deliveryId: "del-1",
    });
    const json1 = await res1.json();

    const res2 = await postWebhook(app, makePushPayload({ after: "sha2" }), {
      deliveryId: "del-2",
    });
    const json2 = await res2.json();
    expect(json2.superseded_count).toBe(1);

    const old = deps.changes.getById(json1.change_id);
    expect(old!.status).toBe("superseded");
  });

  test("enqueues scoring job on accepted push", async () => {
    const app = createWebhookRoutes(deps);
    const res = await postWebhook(app, makePushPayload());
    expect(res.status).toBe(201);

    expect(deps.jobs.pendingCount()).toBe(1);
    const job = deps.jobs.claimNext("score_change");
    expect(job).not.toBeNull();
    const payload = JSON.parse(job!.payload);
    expect(payload.change_id).toBeGreaterThan(0);
  });

  test("detects agent-created commits", async () => {
    const app = createWebhookRoutes(deps);
    const payload = makePushPayload({
      commits: [
        {
          id: "abc",
          message: "chore(auto): update deps",
          author: { name: "renovate[bot]", email: "bot@renovate.io" },
          timestamp: new Date().toISOString(),
        },
      ],
    });
    const res = await postWebhook(app, payload);
    const json = await res.json();
    const change = deps.changes.getById(json.change_id);
    expect(change!.created_by).toBe("agent");
  });

  test("logs push_received event with metadata", async () => {
    const app = createWebhookRoutes(deps);
    const res = await postWebhook(app, makePushPayload());
    const json = await res.json();

    const evts = deps.events.listByChangeId(json.change_id);
    expect(evts).toHaveLength(1);
    expect(evts[0].event_type).toBe("push_received");
    const meta = JSON.parse(evts[0].metadata!);
    expect(meta.commits).toBe(1);
    expect(meta.sender).toBe("owner");
  });
});
