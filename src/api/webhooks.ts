import { Hono } from "hono";
import type { ForgejoPushPayload } from "../types";
import type { ChangeQueries, DeliveryQueries, EventQueries, JobQueries } from "../db/queries";
import type { ForgejoClient } from "../forgejo/client";
import { ingestRefUpdate } from "../ingest/ref-updates";

export interface WebhookDeps {
  changes: ChangeQueries;
  events: EventQueries;
  deliveries: DeliveryQueries;
  jobs: JobQueries;
  forgejo: ForgejoClient | null;
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
    const result = ingestRefUpdate(
      {
        changes: deps.changes,
        events: deps.events,
        deliveries: deps.deliveries,
        jobs: deps.jobs,
      },
      {
        repo: payload.repository.full_name,
        branch,
        baseBranch: defaultBranch,
        headSha: payload.after,
        createdBy: detectCreatedBy(payload),
        deliveryId,
        metadata: {
          commits: payload.commits.length,
          sender: payload.sender.login,
          source: "forgejo_webhook",
        },
      }
    );

    if (result.status === "duplicate") {
      return c.json(result, 200);
    }
    if (result.status === "skipped") {
      return c.json(result, 200);
    }
    return c.json(result, 201);
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
