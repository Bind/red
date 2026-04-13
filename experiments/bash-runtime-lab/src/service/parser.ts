import { createHash } from "node:crypto";
import type { ScriptSegment } from "../util/types";

function segmentId(type: ScriptSegment["type"], index: number, explicitId?: string): string {
  if (type === "durable") {
    return explicitId ?? `durable-${index}`;
  }
  return `ephemeral-${index}`;
}

export function hashSegment(script: string, env: Record<string, string>): string {
  const normalizedEnv = Object.entries(env)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");

  return createHash("sha256").update(script).update("\n---\n").update(normalizedEnv).digest("hex");
}

export function parseScript(script: string): ScriptSegment[] {
  const lines = script.split("\n");
  const segments: ScriptSegment[] = [];
  let ephemeralLines: string[] = [];
  let ephemeralStart = 1;
  let durableId: string | null = null;
  let durableLines: string[] = [];
  let durableStart = 0;

  function flushEphemeral(endLine: number) {
    const content = ephemeralLines.join("\n").trim();
    if (!content) {
      ephemeralLines = [];
      ephemeralStart = endLine + 1;
      return;
    }

    const index = segments.length + 1;
    segments.push({
      type: "ephemeral",
      id: segmentId("ephemeral", index),
      script: `${content}\n`,
      startLine: ephemeralStart,
      endLine,
    });
    ephemeralLines = [];
    ephemeralStart = endLine + 1;
  }

  function flushDurable(endLine: number) {
    if (!durableId) {
      throw new Error("Invalid durable block state");
    }

    const content = durableLines.join("\n").trim();
    if (!content) {
      throw new Error(`Durable block "${durableId}" is empty`);
    }

    segments.push({
      type: "durable",
      id: durableId,
      script: `${content}\n`,
      startLine: durableStart,
      endLine,
    });
    durableId = null;
    durableLines = [];
    durableStart = 0;
    ephemeralStart = endLine + 2;
  }

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const lineNumber = index + 1;
    const durableStartMatch = line.match(/^#\s*@durable\s+([A-Za-z0-9._-]+)\s*$/);
    const durableEndMatch = line.match(/^#\s*@enddurable\s*$/);

    if (durableStartMatch) {
      if (durableId) {
        throw new Error(`Nested durable block is not allowed at line ${lineNumber}`);
      }
      flushEphemeral(lineNumber - 1);
      durableId = durableStartMatch[1];
      durableStart = lineNumber + 1;
      continue;
    }

    if (durableEndMatch) {
      if (!durableId) {
        throw new Error(`Unexpected durable block end at line ${lineNumber}`);
      }
      flushDurable(lineNumber - 1);
      continue;
    }

    if (durableId) {
      durableLines.push(line);
    } else {
      ephemeralLines.push(line);
    }
  }

  if (durableId) {
    throw new Error(`Durable block "${durableId}" is missing # @enddurable`);
  }

  flushEphemeral(lines.length);
  return segments;
}
