import type { CliContext } from "./index";

interface VelocityResponse {
  merged: number;
  pending_review: number;
}

interface ChangeResponse {
  id: number;
  repo: string;
  branch: string;
  status: string;
  confidence: string | null;
  created_by: string;
  summary: string | null;
  updated_at: string;
}

export async function statusCommand(ctx: CliContext): Promise<number> {
  try {
    const [velocity, reviewQueue] = await Promise.all([
      fetchJson<VelocityResponse>(`${ctx.apiUrl}/api/velocity`),
      fetchJson<ChangeResponse[]>(`${ctx.apiUrl}/api/review`),
    ]);

    if (ctx.format === "json") {
      console.log(JSON.stringify({ velocity, review_queue: reviewQueue }, null, 2));
      return 0;
    }

    // Text output
    console.log("redc status");
    console.log("═".repeat(50));
    console.log();

    // Velocity
    console.log("Merge velocity (24h):");
    console.log(`  Merged:          ${velocity.merged}`);
    console.log(`  Pending review:  ${velocity.pending_review}`);
    console.log();

    // Review queue
    if (reviewQueue.length === 0) {
      console.log("Review queue: empty");
    } else {
      console.log(`Review queue (${reviewQueue.length}):`);
      console.log(
        "  " +
          padRight("ID", 6) +
          padRight("Repo", 25) +
          padRight("Branch", 20) +
          padRight("Confidence", 14) +
          padRight("By", 8)
      );
      console.log("  " + "─".repeat(73));
      for (const c of reviewQueue) {
        console.log(
          "  " +
            padRight(String(c.id), 6) +
            padRight(truncate(c.repo, 23), 25) +
            padRight(truncate(c.branch, 18), 20) +
            padRight(c.confidence ?? "—", 14) +
            padRight(c.created_by, 8)
        );
      }
    }

    return 0;
  } catch (err) {
    if (err instanceof ApiError) {
      console.error(`Error: could not reach redc API at ${ctx.apiUrl}`);
      console.error(`  ${err.message}`);
      return 1;
    }
    throw err;
  }
}

async function fetchJson<T>(url: string): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url);
  } catch (err) {
    throw new ApiError(`Connection refused — is redc running? (${url})`);
  }
  if (!res.ok) {
    throw new ApiError(`HTTP ${res.status}: ${await res.text()}`);
  }
  return res.json() as Promise<T>;
}

class ApiError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ApiError";
  }
}

function padRight(str: string, len: number): string {
  return str.length >= len ? str.slice(0, len) : str + " ".repeat(len - str.length);
}

function truncate(str: string, max: number): string {
  return str.length <= max ? str : str.slice(0, max - 1) + "…";
}
