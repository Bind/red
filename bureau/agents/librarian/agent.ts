import { join, resolve } from "node:path";
import {
  createPiProvider,
  loadDaemons,
  type AgentProvider,
} from "../../../pkg/daemons/src/index";
import {
  createRouteDecisionTool,
  type RouteDecisionCapture,
} from "../../../pkg/daemons/src/tools/route-decision";
import { runBureauAgent } from "../../runtime";
import { agent, type BureauAgentContext } from "../../sdk";
import {
  librarianModel,
  type Librarian,
  type LibrarianCandidate,
  type LibrarianDecision,
} from "../../workflows/daemon-review/src/routing";

export type LibrarianInput = {
  file: string;
  fileSummary?: string;
  candidates?: LibrarianCandidate[];
};

export type LibrarianOptions = {
  model?: string;
  provider?: AgentProvider;
  cwd?: string;
  maxWallclockMs?: number;
};

function librarianMaxWallclockMs(override?: number): number {
  if (typeof override === "number" && Number.isFinite(override) && override > 0) {
    return override;
  }

  const raw = process.env.DAEMON_REVIEW_LIBRARIAN_MAX_MS;
  if (!raw) return 120_000;

  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 120_000;
}

const LIBRARIAN_INSTRUCTIONS = [
  "You are a reusable routing librarian for daemon-based review systems.",
  "Your job is only to decide which candidate daemons should review one file.",
  "Use the provided daemon metadata, routing scores, and memory signals.",
  "Prefer narrower candidate ownership when a broad candidate is only weakly supported.",
  "It is valid to select zero, one, or many daemons.",
  "Do not audit the file. Do not suggest code changes. Do not invent candidate daemons.",
  "Call the route_decision tool exactly once with selected_daemons, rationale, and confidence.",
  "selected_daemons must be a subset of the provided candidate daemon names.",
  "After route_decision, call complete exactly once with a short plain-language summary.",
].join(" ");

export function buildLibrarianContext(
  cwd: string,
): Omit<BureauAgentContext<LibrarianInput>, "sessionId" | "input"> {
  const root = resolve(cwd);
  const agentDir = join(root, "bureau", "agents", "librarian");
  return {
    name: "librarian",
    sourceRoot: root,
    root,
    cwd: root,
    agentDir,
    assets: { skills: [] },
    emit() {},
    resolveAsset(relativePath: string) {
      return join(agentDir, relativePath);
    },
    resolveSharedAsset(relativePath: string) {
      return join(root, "bureau", "shared", relativePath);
    },
  };
}

function parseDecision(
  payload: RouteDecisionCapture["payload"],
  candidates: LibrarianCandidate[],
): LibrarianDecision {
  const allowed = new Set(candidates.map((candidate) => candidate.daemonName));
  const selectedDaemons = Array.isArray(payload?.selected_daemons)
    ? payload.selected_daemons
        .filter((value): value is string => typeof value === "string" && allowed.has(value))
        .sort((a, b) => a.localeCompare(b))
    : [];
  return {
    selectedDaemons,
    rationale: typeof payload?.rationale === "string" ? payload.rationale : "bureau librarian response",
    confidence: typeof payload?.confidence === "number" ? payload.confidence : undefined,
  };
}

export function librarian(options: LibrarianOptions = {}): Librarian {
  return async (input) => {
    if (input.candidates.length === 0) {
      return {
        selectedDaemons: [],
        rationale: "no candidates supplied",
        confidence: 1,
      };
    }

    const apiKey = process.env.OPENROUTER_API_KEY;
    if (!options.provider && !apiKey) {
      throw new Error("OPENROUTER_API_KEY is required for librarian routing");
    }

    const provider = options.provider
      ?? createPiProvider({
        provider: "openrouter",
        model: options.model ?? librarianModel(),
        apiKey: apiKey!,
      });

    const ctx = buildLibrarianContext(options.cwd ?? process.cwd());
    const capture: RouteDecisionCapture = {};
    const definition = createLibrarianDefinition(capture);
    const execution = await runBureauAgent({
      definition,
      context: ctx,
      input,
      args: input,
      provider,
      maxTurns: 4,
      maxWallclockMs: librarianMaxWallclockMs(options.maxWallclockMs),
    });
    const result = execution.result;

    if (!result.ok) {
      throw new Error(`bureau librarian failed: ${result.reason}: ${result.message}`);
    }

    if (!capture.payload) {
      throw new Error(
        `bureau librarian did not call route_decision\nraw summary:\n${result.payload.summary.slice(0, 1000)}`,
      );
    }

    return parseDecision(capture.payload, input.candidates);
  };
}

export function createLibrarianDefinition(capture: RouteDecisionCapture = {}) {
  return agent<LibrarianInput>()
    .plan(async (ctx) => {
      let candidates = ctx.input.candidates ?? [];
      if (candidates.length === 0) {
        const { specs } = await loadDaemons(ctx.sourceRoot);
        candidates = specs.map((spec) => ({
          daemonName: spec.name,
          profile: spec.description,
          trackedSubjects: [],
          trackedDependencyPaths: [],
          semanticScore: 0,
          scoreBoost: 0,
          finalScore: 0,
          dependencyExact: false,
          checkedExact: false,
          pathNeighborScore: 0,
        }));
      }
      const userPayload = {
        file: ctx.input.file,
        file_summary: ctx.input.fileSummary ?? "",
        candidates: candidates.map((c) => ({
          daemon_name: c.daemonName,
          semantic_score: Number(c.semanticScore.toFixed(3)),
          score_boost: Number(c.scoreBoost.toFixed(3)),
          final_score: Number(c.finalScore.toFixed(3)),
          dependency_exact: c.dependencyExact,
          checked_exact: c.checkedExact,
          path_neighbor_score: Number(c.pathNeighborScore.toFixed(3)),
          tracked_subjects: c.trackedSubjects,
          tracked_dependency_paths: c.trackedDependencyPaths,
          daemon_profile: c.profile,
        })),
      };
      return {
        systemPrompt: LIBRARIAN_INSTRUCTIONS,
        initialInput: `${JSON.stringify(userPayload, null, 2)}\n\nCall route_decision before complete.`,
        tools: [createRouteDecisionTool(capture)],
      };
    })
    .build();
}

export default librarian;
