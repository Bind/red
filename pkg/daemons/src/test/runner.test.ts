import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentProvider, ProviderSession } from "../providers/types";
import { runDaemon } from "../runner";
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

function scriptedProvider(responses: string[]): AgentProvider {
  return {
    name: "scripted",
    async spawn(): Promise<ProviderSession> {
      let i = 0;
      return {
        async run() {
          const r = responses[i];
          i += 1;
          if (r === undefined) throw new Error("scripted provider ran out of responses");
          return {
            finalResponse: r,
            usage: { inputTokens: 10, outputTokens: 5 },
          };
        },
        async stop() {},
      };
    },
  };
}

function completeBlock(summary: string, findings: unknown[] = []): string {
  return "```complete\n" + JSON.stringify({ summary, findings }) + "\n```";
}

describe("runner", () => {
  test("returns success when the first turn emits a valid complete block", async () => {
    await writeDaemon("one-shot", "d");
    const { emit, drain } = memorySink();
    const result = await runDaemon("one-shot", {
      root: dir,
      provider: scriptedProvider([completeBlock("all good")]),
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

  test("continues past turns that don't emit a complete block", async () => {
    await writeDaemon("multi", "d");
    const provider = scriptedProvider([
      "Still thinking...",
      "Almost there.",
      completeBlock("done", [
        { invariant: "readme_just_recipe_exists", target: "install", status: "ok" },
      ]),
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

  test("fails with turn_budget_exceeded when the model never completes", async () => {
    await writeDaemon("forever", "d");
    const provider = scriptedProvider(["nope", "still nope", "again", "and again", "no"]);
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

  test("asks the model to fix a malformed complete block before failing", async () => {
    await writeDaemon("malformed", "d");
    const provider = scriptedProvider([
      "```complete\n{not json}\n```",
      completeBlock("recovered"),
    ]);
    const { emit } = memorySink();
    const result = await runDaemon("malformed", { root: dir, provider, emit });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.turns).toBe(2);
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
    const provider = scriptedProvider(["continue", completeBlock("done")]);
    const { emit } = memorySink();
    const result = await runDaemon("tally", { root: dir, provider, emit });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.tokens.input).toBe(20);
      expect(result.tokens.output).toBe(10);
    }
  });
});
