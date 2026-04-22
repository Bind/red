import { CompletePayload } from "./schema";

const FENCE_RE = /```complete\s*\n([\s\S]*?)```/m;

export type SentinelParseResult =
  | { kind: "complete"; payload: CompletePayload }
  | { kind: "none" }
  | { kind: "malformed"; reason: string };

export function parseCompleteSentinel(finalResponse: string): SentinelParseResult {
  const trimmed = finalResponse.trim();
  const match = FENCE_RE.exec(trimmed);
  if (!match) return { kind: "none" };

  const body = match[1]?.trim();
  if (!body) return { kind: "malformed", reason: "empty complete block" };

  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch (err) {
    return {
      kind: "malformed",
      reason: `invalid JSON in complete block: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  const result = CompletePayload.safeParse(parsed);
  if (!result.success) {
    return {
      kind: "malformed",
      reason: `complete payload failed validation: ${result.error.issues
        .map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`)
        .join("; ")}`,
    };
  }

  return { kind: "complete", payload: result.data };
}

export const COMPLETE_SENTINEL_INSTRUCTIONS = `When — and only when — your task is finished, your final message must be ONLY a fenced JSON block in this exact format:

\`\`\`complete
{
  "summary": "one sentence recap",
  "findings": [
    { "invariant": "snake_case_tag", "target": "optional", "status": "ok|healed|violation_persists|skipped", "note": "optional" }
  ],
  "nextRunHint": "optional advice for the next run"
}
\`\`\`

Do not emit the fenced complete block until you are genuinely done. If you need more turns to finish, keep working normally; the runner will prompt you to continue.`;
