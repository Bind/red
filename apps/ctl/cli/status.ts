import type { CliContext } from "./index";

interface VelocityResponse {
  summarized: number;
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

function writeStdout(line = ""): void {
  process.stdout.write(`${line}\n`);
}

function writeStderr(line: string): void {
  process.stderr.write(`${line}\n`);
}

export async function statusCommand(ctx: CliContext): Promise<number> {
  try {
    const [velocity, reviewQueue] = await Promise.all([
      fetchJson<VelocityResponse>(`${ctx.apiUrl}/api/velocity`),
      fetchJson<ChangeResponse[]>(`${ctx.apiUrl}/api/review`),
    ]);

    if (ctx.format === "json") {
      writeStdout(JSON.stringify({ velocity, review_queue: reviewQueue }, null, 2));
      return 0;
    }

    // Text output
    writeStdout("red status");
    writeStdout("═".repeat(50));
    writeStdout();

    // Velocity
    writeStdout("Queue summary (24h):");
    writeStdout(`  Summarized:      ${velocity.summarized}`);
    writeStdout(`  Pending review:  ${velocity.pending_review}`);
    writeStdout();

    // Review queue
    if (reviewQueue.length === 0) {
      writeStdout("Review queue: empty");
    } else {
      writeStdout(`Review queue (${reviewQueue.length}):`);
      writeStdout(
        "  " +
          padRight("ID", 6) +
          padRight("Repo", 25) +
          padRight("Branch", 20) +
          padRight("Confidence", 14) +
          padRight("By", 8),
      );
      writeStdout(`  ${"─".repeat(73)}`);
      for (const c of reviewQueue) {
        writeStdout(
          "  " +
            padRight(String(c.id), 6) +
            padRight(truncate(c.repo, 23), 25) +
            padRight(truncate(c.branch, 18), 20) +
            padRight(c.confidence ?? "—", 14) +
            padRight(c.created_by, 8),
        );
      }
    }

    return 0;
  } catch (err) {
    if (err instanceof ApiError) {
      writeStderr(`Error: could not reach red API at ${ctx.apiUrl}`);
      writeStderr(`  ${err.message}`);
      return 1;
    }
    throw err;
  }
}

async function fetchJson<T>(url: string): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url);
  } catch {
    throw new ApiError(`Connection refused — is red running? (${url})`);
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
  return str.length <= max ? str : `${str.slice(0, max - 1)}…`;
}
