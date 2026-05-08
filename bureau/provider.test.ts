import { describe, expect, test } from "bun:test";
import { createInMemoryCodexAuthSource } from "../pkg/daemons/src/index";
import { createBureauAgentProvider } from "./provider";
import { justBashSandboxProvider, sandbox } from "./sandbox";

describe("createBureauAgentProvider", () => {
  test("returns the local pi provider for just-bash sandboxes", () => {
    const provider = createBureauAgentProvider({
      sandboxProvider: justBashSandboxProvider,
      repoRoot: process.cwd(),
      authSource: createInMemoryCodexAuthSource({
        access: "test-token",
        refresh: "test-refresh",
        expires: Date.now() + 60_000,
      }),
    });

    expect(provider.name).toBe("pi");
  });

  test("returns the remote bureau provider for remote-container sandboxes", () => {
    const provider = createBureauAgentProvider({
      sandboxProvider: sandbox.remoteContainer({
        runtime: "docker",
        image: "oven/bun:1",
      }),
      repoRoot: process.cwd(),
      env: {
        ...process.env,
        BUREAU_RUNTIME_IMAGE: "oven/bun:1",
      },
    });

    expect(provider.name).toBe("remote-bureau");
  });
});
