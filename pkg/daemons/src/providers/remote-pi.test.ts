import { beforeAll, describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { createRemotePiProvider } from "./remote-pi";
import type { ProviderRunOptions } from "./types";

const TEST_IMAGE = "oven/bun:1";

let dockerAvailable = false;

beforeAll(async () => {
  dockerAvailable = await canRun(["docker", "info"]);
  if (!dockerAvailable) return;
  await runOrThrow(["docker", "pull", TEST_IMAGE]);
}, 60_000);

describe("createRemotePiProvider", () => {
  test("runs one provider turn inside a container and returns a ProviderRunResult", async () => {
    if (!dockerAvailable) return;

    const repoRoot = resolve(process.cwd());
    const provider = createRemotePiProvider({
      runtime: "docker",
      image: TEST_IMAGE,
      repoRoot,
      command: ["bun", "/workspace/pkg/daemons/src/providers/remote-pi-fixture.ts"],
    });

    const result = await provider.runUntilComplete({
      cwd: repoRoot,
      systemPrompt: "You are a remote provider test agent.",
      initialInput: "hello from host",
      maxTurns: 2,
      maxWallclockMs: 5_000,
    } satisfies ProviderRunOptions);

    expect(result).toEqual({
      ok: true,
      payload: {
        summary: "remote provider completed",
        findings: [],
      },
      turns: 1,
      tokens: { input: 4, output: 7 },
      session: {
        systemPrompt: "You are a remote provider test agent.",
        messages: [
          { role: "user", content: "hello from host" },
          { role: "assistant", content: "remote provider completed" },
        ],
      },
    });
  }, 60_000);

  test("streams provider callbacks from container events", async () => {
    if (!dockerAvailable) return;

    const repoRoot = resolve(process.cwd());
    const provider = createRemotePiProvider({
      runtime: "docker",
      image: TEST_IMAGE,
      repoRoot,
      command: ["bun", "/workspace/pkg/daemons/src/providers/remote-pi-callback-fixture.ts"],
    });
    const callbacks: string[] = [];

    const result = await provider.runUntilComplete({
      cwd: repoRoot,
      systemPrompt: "callback test",
      initialInput: "stream please",
      maxTurns: 2,
      maxWallclockMs: 5_000,
      onTurnStart(turnIndex) {
        callbacks.push(`turn.started:${turnIndex}`);
      },
      onToolCall(turnIndex, toolName, args) {
        callbacks.push(`tool.called:${turnIndex}:${toolName}:${JSON.stringify(args)}`);
      },
      onAssistantTextDelta(turnIndex, delta) {
        callbacks.push(`assistant.delta:${turnIndex}:${delta}`);
      },
      onTurnEnd(turnIndex, info) {
        callbacks.push(
          `turn.completed:${turnIndex}:${info.tokens.input}:${info.tokens.output}:${info.completeCalled}`,
        );
      },
    } satisfies ProviderRunOptions);

    expect(callbacks).toEqual([
      "turn.started:1",
      'tool.called:1:read:{"path":"README.md"}',
      "assistant.delta:1:remote delta",
      "turn.completed:1:2:3:true",
    ]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.payload.summary).toBe("callback fixture completed");
    }
  }, 60_000);
});

async function canRun(cmd: string[]): Promise<boolean> {
  const proc = Bun.spawn({ cmd, stdout: "ignore", stderr: "ignore" });
  return (await proc.exited) === 0;
}

async function runOrThrow(cmd: string[]): Promise<void> {
  const proc = Bun.spawn({ cmd, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (exitCode !== 0) {
    throw new Error(`${cmd.join(" ")} failed: ${stderr || stdout}`);
  }
}
