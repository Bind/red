import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentProvider, ProviderSession, ProviderTurn } from "../providers/types";
import { runDaemon } from "../runner";
import { memorySink } from "../wide-events";
import type { CompletePayload } from "../schema";

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

type ScriptStep =
  | { complete: CompletePayload; finalResponse?: string }
  | { finalResponse: string };

function scriptedProvider(steps: ScriptStep[]): AgentProvider {
  return {
    name: "scripted",
    async spawn(): Promise<ProviderSession> {
      let i = 0;
      return {
        async run(): Promise<ProviderTurn> {
          const step = steps[i];
          i += 1;
          if (step === undefined) throw new Error("scripted provider ran out of responses");
          return {
            finalResponse: step.finalResponse ?? "",
            usage: { inputTokens: 10, outputTokens: 5 },
            complete: "complete" in step ? step.complete : undefined,
          };
        },
        async stop() {},
      };
    },
  };
}

describe("runner", () => {
  test("returns success when the first turn reports complete", async () => {
    await writeDaemon("one-shot", "d");
    const { emit, drain } = memorySink();
    const result = await runDaemon("one-shot", {
      root: dir,
      provider: scriptedProvider([
        { complete: { summary: "all good", findings: [] } },
      ]),
      emit,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.turns).toBe(1);
      expect(result.payload.summary).toBe("all good");
    }
    const kinds = drain().map((e) => e.kind);
    expect(kinds).toContain("daemon.run.started");
    expect(kinds).toContain("daemon.turn.completed");
    expect(kinds).toContain("daemon.run.completed");
  });

  test("continues past turns that don't call complete", async () => {
    await writeDaemon("multi", "d");
    const provider = scriptedProvider([
      { finalResponse: "Still thinking..." },
      { finalResponse: "Almost there." },
      {
        complete: {
          summary: "done",
          findings: [
            { invariant: "readme_just_recipe_exists", target: "install", status: "ok" },
          ],
        },
      },
    ]);
    const { emit, drain } = memorySink();
    const result = await runDaemon("multi", { root: dir, provider, emit });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.turns).toBe(3);
      expect(result.payload.findings).toHaveLength(1);
    }
    const findings = drain().filter((e) => e.kind === "daemon.finding");
    expect(findings).toHaveLength(1);
    expect(findings[0]?.data.invariant).toBe("readme_just_recipe_exists");
  });

  test("fails with turn_budget_exceeded when complete is never called", async () => {
    await writeDaemon("forever", "d");
    const provider = scriptedProvider([
      { finalResponse: "nope" },
      { finalResponse: "still nope" },
      { finalResponse: "again" },
      { finalResponse: "and again" },
      { finalResponse: "no" },
    ]);
    const { emit } = memorySink();
    const result = await runDaemon("forever", {
      root: dir,
      provider,
      emit,
      maxTurns: 3,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("turn_budget_exceeded");
      expect(result.turns).toBe(3);
    }
  });

  test("surfaces provider errors as provider_error failures", async () => {
    await writeDaemon("boom", "d");
    const provider: AgentProvider = {
      name: "boom",
      async spawn() {
        return {
          async run() {
            throw new Error("api exploded");
          },
          async stop() {},
        };
      },
    };
    const { emit } = memorySink();
    const result = await runDaemon("boom", { root: dir, provider, emit });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("provider_error");
      expect(result.message).toBe("api exploded");
    }
  });

  test("accumulates tokens across turns", async () => {
    await writeDaemon("tally", "d");
    const provider = scriptedProvider([
      { finalResponse: "continue" },
      { complete: { summary: "done", findings: [] } },
    ]);
    const { emit } = memorySink();
    const result = await runDaemon("tally", { root: dir, provider, emit });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.tokens.input).toBe(20);
      expect(result.tokens.output).toBe(10);
    }
  });

  test("emits completeCalled flag on the turn.completed event", async () => {
    await writeDaemon("flag", "d");
    const provider = scriptedProvider([
      { finalResponse: "working" },
      { complete: { summary: "done", findings: [] } },
    ]);
    const { emit, drain } = memorySink();
    await runDaemon("flag", { root: dir, provider, emit });
    const turnCompleted = drain().filter((e) => e.kind === "daemon.turn.completed");
    expect(turnCompleted[0]?.data.completeCalled).toBe(false);
    expect(turnCompleted[1]?.data.completeCalled).toBe(true);
  });
});
