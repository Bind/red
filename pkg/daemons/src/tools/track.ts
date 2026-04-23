import { Type, type Static } from "@mariozechner/pi-ai";
import type { AgentTool } from "@mariozechner/pi-agent-core";
import type { DaemonMemoryStore, TrackEntry } from "../memory";

export const TRACK_TOOL_NAME = "track";
const MAX_FACT_BYTES = 16 * 1024;

const TrackParams = Type.Object(
  {
    action: Type.Union([
      Type.Literal("record"),
      Type.Literal("lookup"),
      Type.Literal("invalidate"),
    ]),
    subject: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
    subjects: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 256 }), { maxItems: 100 })),
    fingerprint: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
    fact: Type.Optional(Type.Any()),
    depends_on: Type.Optional(
      Type.Array(Type.String({ minLength: 1, maxLength: 256 }), { maxItems: 100 }),
    ),
  },
  { additionalProperties: false },
);

export function createTrackTool(
  store: DaemonMemoryStore,
  runId: string,
): AgentTool<typeof TrackParams> {
  return {
    name: TRACK_TOOL_NAME,
    label: "Track",
    description:
      "Store, lookup, or invalidate daemon-local tracked facts between runs. Memory is isolated per daemon and persisted to the daemon cache.",
    parameters: TrackParams,
    async execute(_toolCallId, params: Static<typeof TrackParams>) {
      switch (params.action) {
        case "lookup": {
          const subjects = normalizeSubjects(params.subject, params.subjects);
          const entries = store.lookup(subjects);
          return {
            content: [
              {
                type: "text" as const,
                text:
                  entries.length === 0
                    ? "No tracked entries found."
                    : `Found ${entries.length} tracked entr${entries.length === 1 ? "y" : "ies"}.`,
              },
            ],
            details: { entries },
          };
        }

        case "invalidate": {
          const subjects = requireSubjects(params.subject, params.subjects, "invalidate");
          const removed = await store.invalidate(subjects);
          return {
            content: [
              {
                type: "text" as const,
                text: `Invalidated ${removed} tracked entr${removed === 1 ? "y" : "ies"}.`,
              },
            ],
            details: { removed, subjects },
          };
        }

        case "record": {
          const subject = requireSubject(params.subject, "record");
          if (!params.fingerprint) {
            throw new Error("track.record requires fingerprint");
          }
          ensureFactSize(params.fact);
          const entry: TrackEntry = {
            subject,
            fingerprint: params.fingerprint,
            fact: params.fact ?? null,
            depends_on: [...new Set(params.depends_on ?? [])].sort(),
            checked_at: new Date().toISOString(),
            source_run_id: runId,
          };
          await store.record(entry);
          return {
            content: [
              {
                type: "text" as const,
                text: `Tracked subject ${subject}.`,
              },
            ],
            details: { entry },
          };
        }
      }
    },
  };
}

function normalizeSubjects(subject?: string, subjects?: string[]): string[] | undefined {
  if (Array.isArray(subjects) && subjects.length > 0) return [...new Set(subjects)].sort();
  if (subject) return [subject];
  return undefined;
}

function requireSubjects(subject: string | undefined, subjects: string[] | undefined, action: string): string[] {
  const normalized = normalizeSubjects(subject, subjects);
  if (!normalized || normalized.length === 0) {
    throw new Error(`track.${action} requires subject or subjects`);
  }
  return normalized;
}

function requireSubject(subject: string | undefined, action: string): string {
  if (!subject) throw new Error(`track.${action} requires subject`);
  return subject;
}

function ensureFactSize(fact: unknown): void {
  const encoded = JSON.stringify(fact ?? null);
  if (Buffer.byteLength(encoded, "utf8") > MAX_FACT_BYTES) {
    throw new Error(`track.record fact exceeds ${MAX_FACT_BYTES} bytes`);
  }
}
