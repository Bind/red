import { beforeAll, describe, expect, test } from "bun:test";
import { resolve } from "node:path";

const TEST_IMAGE = "oven/bun:1";

let dockerAvailable = false;

beforeAll(async () => {
  dockerAvailable = await canRun(["docker", "info"]);
  if (!dockerAvailable) return;
  await runOrThrow(["docker", "pull", TEST_IMAGE]);
}, 60_000);

describe("bureau container entry", () => {
  test("builds bureau-local tools inside the container runtime", async () => {
    if (!dockerAvailable) return;

    const repoRoot = resolve(process.cwd());
    const proc = Bun.spawn({
      cmd: [
        "docker",
        "run",
        "--rm",
        "-i",
        "-v",
        `${repoRoot}:/workspace`,
        "-w",
        "/workspace",
        TEST_IMAGE,
        "bun",
        "/workspace/bureau/container-entry.ts",
      ],
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });

    proc.stdin.write(
        JSON.stringify({
          mode: "fixture.capture-tools",
          root: "/workspace",
          agentName: "__fixture_local_tool__",
          args: null,
          userInput: null,
          maxTurns: 1,
          maxWallclockMs: 5_000,
      }),
    );
    proc.stdin.end();

    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);

    expect(exitCode).toBe(0);
    expect(stderr.trim()).toBe("");

    const event = JSON.parse(stdout.trim()) as {
      type: "result";
      result: {
        ok: true;
        payload: {
          summary: string;
          findings: [];
          toolNames: string[];
          cwd: string;
        };
      };
    };

    expect(event.type).toBe("result");
    expect(event.result.ok).toBe(true);
    expect(event.result.payload.toolNames).toContain("fixture-local-tool");
    expect(event.result.payload.cwd).toContain("/workspace");
  }, 60_000);

  test("resolves and runs a real bureau agent inside the container", async () => {
    if (!dockerAvailable) return;

    const repoRoot = resolve(process.cwd());
    const proc = Bun.spawn({
      cmd: [
        "docker",
        "run",
        "--rm",
        "-i",
        "-v",
        `${repoRoot}:/workspace`,
        "-w",
        "/workspace",
        TEST_IMAGE,
        "bun",
        "/workspace/bureau/container-entry.ts",
      ],
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });

    proc.stdin.write(
      JSON.stringify({
        mode: "fixture.run-agent",
        root: "/workspace",
        agentName: "librarian",
        args: {
          file: "apps/ctl/index.ts",
          fileSummary: "CLI entrypoint",
          candidates: [],
        },
        userInput: null,
        maxTurns: 1,
        maxWallclockMs: 5_000,
      }),
    );
    proc.stdin.end();

    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);

    expect(exitCode).toBe(0);
    expect(stderr.trim()).toBe("");

    const event = JSON.parse(stdout.trim()) as {
      type: "result";
      result: {
        ok: true;
        payload: {
          summary: string;
          findings: [];
        };
        session: {
          systemPrompt: string;
          messages: Array<{ role: string; content: unknown }>;
        };
      };
    };

    expect(event.type).toBe("result");
    expect(event.result.ok).toBe(true);
    expect(event.result.payload.summary).toContain("librarian");
    expect(event.result.session.systemPrompt).toContain("routing librarian");
    expect(event.result.session.messages[0]).toEqual({
      role: "user",
      content: expect.stringContaining("\"file\": \"apps/ctl/index.ts\""),
    });
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
