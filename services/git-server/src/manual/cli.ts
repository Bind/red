#!/usr/bin/env bun
import { InMemoryChangeStore } from "../core/change-store";
import { MockGitSdk } from "../core/mock-git-sdk";
import { describeExperimentArchitecture } from "../core/api";
import { runExample, runForkedExample } from "../examples/sdk-examples";
import { runIntegration } from "../integration/run-integration";

type Command = "list" | "describe" | "example" | "forked-example" | "integration";

const USAGE = `Usage:
  bun run src/manual/cli.ts list
  bun run src/manual/cli.ts describe
  bun run src/manual/cli.ts example
  bun run src/manual/cli.ts forked-example
  bun run src/manual/cli.ts integration
`;

function parseArgs(argv: string[]): Command {
  const command = (argv[0] ?? "list") as Command;
  if (
    command !== "list" &&
    command !== "describe" &&
    command !== "example" &&
    command !== "forked-example" &&
    command !== "integration"
  ) {
    throw new Error(`Unknown command: ${command}`);
  }
  return command;
}

function printList() {
  console.log("git-server commands");
  console.log("");
  console.log("  list       Show available commands");
  console.log("  describe   Print the current architecture and adapter shape");
  console.log("  example    Print an end-to-end SDK usage example");
  console.log("  forked-example Print a base-repo plus agent-repo review example");
  console.log("  integration Run a live git-backed integration harness");
}

async function printDescribe() {
  const store = new MockGitSdk({
    publicUrl: "https://git.example.redc.internal",
    defaultOwner: "redc",
  });
  const repo = await store.createRepo({
    name: "demo",
    defaultBranch: "main",
    ephemeral: false,
  });
  const changes = new InMemoryChangeStore();
  const draft = await changes.create({
    repoId: "redc/demo",
    baseRef: "refs/heads/main",
    headRef: "refs/heads/experiments/git-server",
    status: "draft",
  });

  console.log(
    JSON.stringify(
      {
        architecture: describeExperimentArchitecture(),
        store: {
          name: store.name,
          capabilities: store.capabilities,
        },
        repo: {
          info: await repo.info(),
          exampleRemote: await repo.getRemoteUrl({
            actorId: "agent-redc",
            ttlSeconds: 3600,
          }),
          exampleDiff: await repo.getCommitDiff({
            baseRef: "refs/heads/main",
            headRef: "refs/heads/experiments/git-server",
          }),
        },
        product: {
          changeStore: "InMemoryChangeStore",
          exampleChange: draft,
        },
      },
      null,
      2
    )
  );
}

async function main(argv: string[]) {
  const command = parseArgs(argv);
  if (command === "list") {
    printList();
    return;
  }
  if (command === "example") {
    console.log(JSON.stringify(await runExample(), null, 2));
    return;
  }
  if (command === "forked-example") {
    console.log(JSON.stringify(await runForkedExample(), null, 2));
    return;
  }
  if (command === "integration") {
    console.log(JSON.stringify(await runIntegration(), null, 2));
    return;
  }
  await printDescribe();
}

try {
  await main(process.argv.slice(2));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  console.error(USAGE);
  process.exit(1);
}
