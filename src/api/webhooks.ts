import { Hono } from "hono";
import type { ForgejoPushPayload } from "../types";
import type { ChangeQueries, DeliveryQueries, EventQueries, JobQueries } from "../db/queries";
import type { ForgejoClient } from "../forgejo/client";
import { ChangeStateMachine } from "../engine/state-machine";

export interface WebhookDeps {
  changes: ChangeQueries;
  events: EventQueries;
  deliveries: DeliveryQueries;
  jobs: JobQueries;
  forgejo: ForgejoClient;
  webhookSecret: string;
}

/**
 * Create the webhook route handler.
 * POST /webhook/push — receives Forgejo push events.
 *
 * Flow:
 *   1. Validate HMAC signature
 *   2. Check delivery ID for idempotency
 *   3. Parse branch from ref, ignore pushes to default branch
 *   4. Create change record, supersede prior changes on same branch
 *   5. Enqueue scoring job
 */
export function createWebhookRoutes(deps: WebhookDeps): Hono {
  const app = new Hono();

  app.post("/webhook/push", async (c) => {
    // 1. Validate HMAC signature
    const signature = c.req.header("X-Gitea-Signature") ?? "";
    const body = await c.req.text();

    if (!signature) {
      return c.json({ error: "Missing signature" }, 401);
    }

    const valid = await verifySignature(body, signature, deps.webhookSecret);
    if (!valid) {
      return c.json({ error: "Invalid signature" }, 401);
    }

    // 2. Idempotency check
    const deliveryId = c.req.header("X-Gitea-Delivery") ?? "";
    if (!deliveryId) {
      return c.json({ error: "Missing delivery ID" }, 400);
    }

    if (deps.deliveries.isDuplicate(deliveryId)) {
      return c.json({ status: "duplicate", delivery_id: deliveryId }, 200);
    }

    // 3. Parse payload and extract branch
    const payload: ForgejoPushPayload = JSON.parse(body);
    const branch = payload.ref.replace("refs/heads/", "");
    const defaultBranch = payload.repository.default_branch;

    // Ignore pushes directly to the default branch
    if (branch === defaultBranch) {
      deps.deliveries.record(deliveryId);
      return c.json({ status: "skipped", reason: "default branch" }, 200);
    }

    // Determine creator type from commit messages (simple heuristic)
    const createdBy = detectCreatedBy(payload);

    // 4. Create change record
    const repoFullName = payload.repository.full_name;
    const change = deps.changes.create({
      org_id: "default",
      repo: repoFullName,
      branch,
      base_branch: defaultBranch,
      head_sha: payload.after,
      created_by: createdBy,
      delivery_id: deliveryId,
    });

    // Log initial event
    deps.events.append({
      change_id: change.id,
      event_type: "push_received",
      to_status: "pushed",
      metadata: JSON.stringify({
        commits: payload.commits.length,
        sender: payload.sender.login,
      }),
    });

    // Supersede prior changes on same branch
    const sm = new ChangeStateMachine(deps.changes, deps.events);
    const superseded = sm.supersedePrior(repoFullName, branch, change.id);

    // 5. Enqueue scoring job
    deps.jobs.enqueue({
      org_id: "default",
      type: "score_change",
      payload: JSON.stringify({ change_id: change.id }),
    });

    // Record delivery as processed
    deps.deliveries.record(deliveryId);

    return c.json({
      status: "accepted",
      change_id: change.id,
      superseded_count: superseded,
    }, 201);
  });

  return app;
}

/**
 * Verify Forgejo HMAC-SHA256 webhook signature.
 */
async function verifySignature(
  body: string,
  signature: string,
  secret: string
): Promise<boolean> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(body)
  );
  const expected = Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

  // Constant-time comparison
  if (expected.length !== signature.length) return false;
  let result = 0;
  for (let i = 0; i < expected.length; i++) {
    result |= expected.charCodeAt(i) ^ signature.charCodeAt(i);
  }
  return result === 0;
}

/**
 * Simple heuristic: if any commit author email contains "bot" or "[bot]",
 * or commit message starts with common agent prefixes, mark as agent-created.
 */
function detectCreatedBy(payload: ForgejoPushPayload): "human" | "agent" {
  for (const commit of payload.commits) {
    if (
      commit.author.email.includes("bot") ||
      commit.author.name.includes("[bot]") ||
      commit.message.startsWith("chore(auto):") ||
      commit.message.startsWith("fix(auto):")
    ) {
      return "agent";
    }
  }
  return "human";
}
