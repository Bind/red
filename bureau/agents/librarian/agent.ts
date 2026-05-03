import { join, resolve } from "node:path";
import {
  createPiProvider,
  type AgentProvider,
} from "../../../pkg/daemons/src/index";
import {
  createRouteDecisionTool,
  type RouteDecisionCapture,
} from "../../../pkg/daemons/src/tools/route-decision";
import { agent, type BureauAgentContext } from "../../sdk";
import {
  librarianModel,
  type Librarian,
  type LibrarianCandidate,
  type LibrarianDecision,
} from "../../workflows/daemon-review/src/routing";

export type LibrarianInput = {
  file: string;
  fileSummary: string;
  candidates: LibrarianCandidate[];
};

export type LibrarianOptions = {
  model?: string;
  provider?: AgentProvider;
  cwd?: string;
};

const librarianAgent = agent<LibrarianInput>()
  .instructions(
    [
      "You are a reusable routing librarian for daemon-based review systems.",
      "Your job is only to decide which candidate daemons should review one file.",
      "Use the provided daemon metadata, routing scores, and memory signals.",
      "Prefer narrower candidate ownership when a broad candidate is only weakly supported.",
      "It is valid to select zero, one, or many daemons.",
      "Do not audit the file. Do not suggest code changes. Do not invent candidate daemons.",
      "Call the route_decision tool exactly once with selected_daemons, rationale, and confidence.",
      "selected_daemons must be a subset of the provided candidate daemon names.",
      "After route_decision, call complete exactly once with a short plain-language summary.",
    ].join(" "),
  )
  .initialInput((ctx) => {
    const userPayload = {
      file: ctx.input.file,
      file_summary: ctx.input.fileSummary,
      candidates: ctx.input.candidates.map((candidate) => ({
        daemon_name: candidate.daemonName,
        semantic_score: Number(candidate.semanticScore.toFixed(3)),
        score_boost: Number(candidate.scoreBoost.toFixed(3)),
        final_score: Number(candidate.finalScore.toFixed(3)),
        dependency_exact: candidate.dependencyExact,
        checked_exact: candidate.checkedExact,
        path_neighbor_score: Number(candidate.pathNeighborScore.toFixed(3)),
        tracked_subjects: candidate.trackedSubjects,
        tracked_dependency_paths: candidate.trackedDependencyPaths,
        daemon_profile: candidate.profile,
      })),
    };

    return `${JSON.stringify(userPayload, null, 2)}\n\nCall route_decision before complete.`;
  })
  .tools(() => {
    throw new Error("route_decision tool capture was not configured");
  });

function buildContext(input: LibrarianInput, cwd: string): BureauAgentContext<LibrarianInput> {
  const root = resolve(cwd);
  const agentDir = join(root, "bureau", "agents", "librarian");
  return {
    name: "librarian",
    sessionId: `librarian_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
    sourceRoot: root,
    root,
    cwd: root,
    input,
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

    const ctx = buildContext(input, options.cwd ?? process.cwd());
    const capture: RouteDecisionCapture = {};
    const plan = await librarianAgent
      .tools(() => [createRouteDecisionTool(capture)])
      .build()
      .run(ctx);
    const result = await provider.runUntilComplete({
      cwd: plan.cwd ?? ctx.cwd,
      systemPrompt: plan.systemPrompt,
      initialInput: plan.initialInput,
      maxTurns: 4,
      maxWallclockMs: 120_000,
      extraTools: plan.tools ?? [],
    });

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

export default librarian;
