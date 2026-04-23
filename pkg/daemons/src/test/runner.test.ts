import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  AgentProvider,
  ProviderRunOptions,
  ProviderRunResult,
} from "../providers/types";
import { runDaemon } from "../runner";
import type { CompletePayload } from "../schema";
import { memorySink } from "../wide-events";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "daemons-runner-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function writeDaemon(
  name: string,
  description: string,
  body = "do work",
): Promise<void> {
  await writeFile(
    join(dir, `${name}.daemon.md`),
    `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}\n`,
  );
}

type MockScenario = {
  turns: number;
  perTurnTokens?: { input: number; output: number };
  toolCallsPerTurn?: Array<Array<{ name: string; args?: unknown }>>;
  outcome:
    | { kind: "complete"; payload: CompletePayload }
    | { kind: "turn_budget" }
    | { kind: "wallclock" }
    | { kind: "provider_error"; message: string };
};

function mockProvider(scenario: MockScenario): AgentProvider {
  const perTurnTokens = scenario.perTurnTokens ?? { input: 10, output: 5 };
  return {
    name: "mock",
    async runUntilComplete(opts: ProviderRunOptions): Promise<ProviderRunResult> {
      const turns = Math.min(scenario.turns, opts.maxTurns);
      const tokens = { input: 0, output: 0 };
      for (let i = 1; i <= turns; i += 1) {
        opts.onTurnStart?.(i);
        for (const tool of scenario.toolCallsPerTurn?.[i - 1] ?? []) {
          opts.onToolCall?.(i, tool.name, tool.args);
        }
        tokens.input += perTurnTokens.input;
        tokens.output += perTurnTokens.output;
        const completeCalled =
          scenario.outcome.kind === "complete" && i === turns;
        opts.onTurnEnd?.(i, { tokens: perTurnTokens, completeCalled });
      }
      if (scenario.outcome.kind === "complete") {
        return { ok: true, payload: scenario.outcome.payload, turns, tokens };
      }
      if (scenario.outcome.kind === "turn_budget") {
        return {
          ok: false,
          reason: "turn_budget_exceeded",
          message: `exceeded max turns (${opts.maxTurns})`,
          turns,
          tokens,
        };
      }
      if (scenario.outcome.kind === "wallclock") {
        return {
          ok: false,
          reason: "wallclock_exceeded",
          message: `exceeded max wallclock (${opts.maxWallclockMs}ms)`,
          turns,
          tokens,
        };
      }
      return {
        ok: false,
        reason: "provider_error",
        message: scenario.outcome.message,
        turns,
        tokens,
      };
    },
  };
}

describe("runner", () => {
  test("emits started → per-turn → finding → completed on success", async () => {
    await writeDaemon("one-shot", "d");
    const { emit, drain } = memorySink();
    const result = await runDaemon("one-shot", {
      root: dir,
      provider: mockProvider({
        turns: 1,
        outcome: {
          kind: "complete",
          payload: {
            summary: "all good",
            findings: [
              { invariant: "readme_just_recipe_exists", target: "install", status: "ok" },
            ],
          },
        },
      }),
      emit,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.turns).toBe(1);
      expect(result.payload.summary).toBe("all good");
    }

    const kinds = drain().map((e) => e.kind);
    expect(kinds).toContain("daemon.run.started");
    expect(kinds).toContain("daemon.turn.started");
    expect(kinds).toContain("daemon.turn.completed");
    expect(kinds).toContain("daemon.finding");
    expect(kinds).toContain("daemon.run.completed");
  });

  test("reports turn_budget_exceeded verbatim from the provider", async () => {
    await writeDaemon("forever", "d");
    const { emit } = memorySink();
    const result = await runDaemon("forever", {
      root: dir,
      provider: mockProvider({ turns: 3, outcome: { kind: "turn_budget" } }),
      emit,
      maxTurns: 3,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("turn_budget_exceeded");
      expect(result.turns).toBe(3);
    }
  });

  test("reports wallclock_exceeded from the provider", async () => {
    await writeDaemon("slow", "d");
    const { emit } = memorySink();
    const result = await runDaemon("slow", {
      root: dir,
      provider: mockProvider({ turns: 1, outcome: { kind: "wallclock" } }),
      emit,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("wallclock_exceeded");
  });

  test("reports provider_error from the provider", async () => {
    await writeDaemon("boom", "d");
    const { emit } = memorySink();
    const result = await runDaemon("boom", {
      root: dir,
      provider: mockProvider({
        turns: 0,
        outcome: { kind: "provider_error", message: "api exploded" },
      }),
      emit,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("provider_error");
      expect(result.message).toBe("api exploded");
    }
  });

  test("accumulates tokens across multi-turn runs", async () => {
    await writeDaemon("tally", "d");
    const { emit } = memorySink();
    const result = await runDaemon("tally", {
      root: dir,
      provider: mockProvider({
        turns: 3,
        perTurnTokens: { input: 7, output: 3 },
        outcome: { kind: "complete", payload: { summary: "done", findings: [] } },
      }),
      emit,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.tokens.input).toBe(21);
      expect(result.tokens.output).toBe(9);
    }
  });

  test("emits daemon.tool.called for each tool invocation", async () => {
    await writeDaemon("tools", "d");
    const { emit, drain } = memorySink();
    await runDaemon("tools", {
      root: dir,
      provider: mockProvider({
        turns: 2,
        toolCallsPerTurn: [
          [{ name: "read" }],
          [{ name: "read" }, { name: "complete" }],
        ],
        outcome: { kind: "complete", payload: { summary: "ok", findings: [] } },
      }),
      emit,
    });
    const toolCalls = drain().filter((e) => e.kind === "daemon.tool.called");
    expect(toolCalls).toHaveLength(3);
    expect(toolCalls[0]?.data.toolName).toBe("read");
    expect(toolCalls[2]?.data.toolName).toBe("complete");
  });

  test("writes daemon memory for checked read files and reuses it in the next prompt", async () => {
    await writeDaemon("memory", "d", "read files");
    await writeFile(join(dir, "notes.txt"), "hello\n");
    const memoryDir = join(dir, ".cache");

    await runDaemon("memory", {
      root: dir,
      memoryDir,
      provider: mockProvider({
        turns: 1,
        toolCallsPerTurn: [[{ name: "read", args: { path: "notes.txt" } }]],
        outcome: { kind: "complete", payload: { summary: "cached", findings: [] } },
      }),
    });

    let capturedSystemPrompt = "";
    await runDaemon("memory", {
      root: dir,
      memoryDir,
      provider: {
        name: "capture",
        async runUntilComplete(opts: ProviderRunOptions): Promise<ProviderRunResult> {
          capturedSystemPrompt = opts.systemPrompt;
          return { ok: true, payload: { summary: "done", findings: [] }, turns: 1, tokens: { input: 0, output: 0 } };
        },
      },
    });

    expect(capturedSystemPrompt).toContain("Runner-managed memory from the last successful run is available.");
    expect(capturedSystemPrompt).toContain("Previously checked and unchanged:");
    expect(capturedSystemPrompt).toContain("notes.txt");
  });
});
