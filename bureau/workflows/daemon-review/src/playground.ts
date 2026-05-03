import { loadDaemons } from "../../../../pkg/daemons/src/index";
import librarian from "../../../librarian/agent";
import {
  evaluateRouting,
  type RouterMode,
  type RouterProvider,
  type RoutingEvaluation,
} from "./routing";
import { playgroundLogger } from "./logger";
import type { DaemonRoutingMemory } from "./routing-memory";
import { ROUTING_TRAINING_SET } from "./training-set";

export type PlaygroundProfile = {
  id: string;
  name: string;
  mode: RouterMode;
  routerProvider?: RouterProvider;
  routerModel?: string;
  librarianModel?: string;
};

export type PlaygroundScenarioResult = {
  scenario: string;
  files: string[];
  expectedByFile: Record<string, string[]>;
  evaluation: RoutingEvaluation;
};

export type PlaygroundProfileResult = {
  profile: PlaygroundProfile;
  scenarios: PlaygroundScenarioResult[];
};

export type PlaygroundRunResult = {
  generatedAt: string;
  profiles: PlaygroundProfileResult[];
};

export const DEFAULT_PLAYGROUND_PROFILES: PlaygroundProfile[] = [
  {
    id: "memory-embedding",
    name: "Memory + Embeddings",
    mode: "memory_embedding",
    routerProvider: "openrouter",
    routerModel: "openai/text-embedding-3-small",
  },
  {
    id: "librarian-flash",
    name: "Librarian Flash",
    mode: "memory_embedding_librarian",
    routerProvider: "openrouter",
    routerModel: "openai/text-embedding-3-small",
    librarianModel: "deepseek/deepseek-v4-flash",
  },
];

function scenarioMemoryToMap(
  memoryByDaemon?: Record<string, DaemonRoutingMemory>,
): Map<string, DaemonRoutingMemory> | undefined {
  return memoryByDaemon ? new Map(Object.entries(memoryByDaemon)) : undefined;
}

function logPlaygroundDebug(message: string, fields?: Record<string, unknown>): void {
  if (!fields || Object.keys(fields).length === 0) {
    playgroundLogger.info("{message}", { message });
    return;
  }
  playgroundLogger.info("{message}", { message, ...fields });
}

export async function runDaemonPlayground(
  profiles: PlaygroundProfile[] = DEFAULT_PLAYGROUND_PROFILES,
): Promise<PlaygroundRunResult> {
  const runStartedAt = performance.now();
  const { specs, errors } = await loadDaemons(process.cwd());
  if (errors.length > 0) {
    throw new Error(errors.map((error) => `${error.file}: ${error.message}`).join("\n"));
  }

  const profileResults: PlaygroundProfileResult[] = [];
  const totalProfiles = profiles.length;
  const totalScenarios = ROUTING_TRAINING_SET.length;
  for (let profileIndex = 0; profileIndex < profiles.length; profileIndex += 1) {
    const profile = profiles[profileIndex]!;
    const profileStartedAt = performance.now();
    const scenarios: PlaygroundScenarioResult[] = [];
    logPlaygroundDebug("profile_start", {
      profile: profile.name,
      mode: profile.mode,
      progress: `${profileIndex + 1}/${totalProfiles}`,
    });
    for (let scenarioIndex = 0; scenarioIndex < ROUTING_TRAINING_SET.length; scenarioIndex += 1) {
      const scenario = ROUTING_TRAINING_SET[scenarioIndex]!;
      const scenarioStartedAt = performance.now();
      const routingLibrarian = profile.mode === "memory_embedding_librarian"
        ? librarian({
            model: profile.librarianModel,
            cwd: process.cwd(),
          })
        : undefined;
      logPlaygroundDebug("scenario_start", {
        profile: profile.name,
        scenario: scenario.name,
        progress: `${scenarioIndex + 1}/${totalScenarios}`,
      });
      const evaluation = await evaluateRouting(scenario.files, specs, {
        modeOverride: profile.mode,
        memoryByDaemon: scenarioMemoryToMap(scenario.memoryByDaemon),
        routerProviderOverride: profile.routerProvider,
        routerModelOverride: profile.routerModel,
        librarianOverride: routingLibrarian,
      });
      scenarios.push({
        scenario: scenario.name,
        files: scenario.files,
        expectedByFile: scenario.expectedByFile,
        evaluation,
      });
      logPlaygroundDebug("scenario_complete", {
        profile: profile.name,
        scenario: scenario.name,
        progress: `${scenarioIndex + 1}/${totalScenarios}`,
        files: scenario.files.length,
        routedDaemons: evaluation.routedDaemons.length,
        durationMs: Math.round((performance.now() - scenarioStartedAt) * 100) / 100,
      });
    }
    profileResults.push({
      profile,
      scenarios,
    });
    logPlaygroundDebug("profile_complete", {
      profile: profile.name,
      mode: profile.mode,
      progress: `${profileIndex + 1}/${totalProfiles}`,
      durationMs: Math.round((performance.now() - profileStartedAt) * 100) / 100,
    });
  }

  logPlaygroundDebug("run_complete", {
    profiles: profiles.length,
    scenarios: ROUTING_TRAINING_SET.length,
    durationMs: Math.round((performance.now() - runStartedAt) * 100) / 100,
  });

  return {
    generatedAt: new Date().toISOString(),
    profiles: profileResults,
  };
}
