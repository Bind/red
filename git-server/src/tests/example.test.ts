import { describe, expect, test } from "bun:test";
import { runExample, runForkedExample } from "../examples/sdk-examples";

async function runCli(command: "example" | "forked-example") {
  const proc = Bun.spawn(["bun", "src/manual/cli.ts", command], {
    cwd: import.meta.dir + "/../..",
    stdout: "pipe",
    stderr: "pipe",
  });

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  return { stdout, stderr, exitCode };
}

describe("git-sdk examples", () => {
  test("runExample returns repo, remote, commit, diff, and change", async () => {
    const result = await runExample();

    expect(result.repo.id).toBe("redc/agent-scratch");
    expect(result.remote.protocol).toBe("smart-http");
    expect(result.commit.branch).toBe("refs/heads/experiments/sdk-example");
    expect(result.diff.baseRef).toBe("refs/heads/main");
    expect(result.change.repoId).toBe("redc/agent-scratch");
  });

  test("runForkedExample returns separate base and head repos", async () => {
    const result = await runForkedExample();

    expect(result.baseRepo.id).toBe("redc/app");
    expect(result.headRepo.id).toBe("agents/app-agent-123");
    expect(result.headRepo.baseRepo?.owner).toBe("redc");
    expect(result.change.repoId).toBe("redc/app");
    expect(result.change.headRepoId).toBe("agents/app-agent-123");
  });
});

describe("git-sdk manual CLI", () => {
  test("example command prints valid JSON", async () => {
    const { stdout, stderr, exitCode } = await runCli("example");

    expect(exitCode).toBe(0);
    expect(stderr).toBe("");

    const json = JSON.parse(stdout) as Awaited<ReturnType<typeof runExample>>;
    expect(json.repo.id).toBe("redc/agent-scratch");
    expect(json.remote.pushUrl).toContain("/git/redc%2Fagent-scratch");
  });

  test("forked-example command prints valid JSON", async () => {
    const { stdout, stderr, exitCode } = await runCli("forked-example");

    expect(exitCode).toBe(0);
    expect(stderr).toBe("");

    const json = JSON.parse(stdout) as Awaited<ReturnType<typeof runForkedExample>>;
    expect(json.baseRepo.id).toBe("redc/app");
    expect(json.headRepo.id).toBe("agents/app-agent-123");
    expect(json.change.headRepoId).toBe("agents/app-agent-123");
  });
});
