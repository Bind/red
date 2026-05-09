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

  test("rejects implicit fixture wiring for remote-container sandboxes", () => {
    expect(() =>
      createBureauAgentProvider({
        sandboxProvider: sandbox.remoteContainer({
          runtime: "docker",
          image: "oven/bun:1",
        }),
        repoRoot: process.cwd(),
      })
    ).toThrow(
      "createBureauAgentProvider does not auto-wire remote sandboxes yet; provide an explicit remote AgentProvider instead",
    );
  });
});
