import {
  createFileCodexAuthSource,
  createPiProvider,
  type AgentProvider,
  type CodexAuthSource,
} from "../pkg/daemons/src/index";
import { createRemoteBureauProvider } from "./remote-provider";
import type { BureauSandboxProvider } from "./sandbox";

export type CreateBureauAgentProviderOptions = {
  sandboxProvider: BureauSandboxProvider;
  repoRoot: string;
  env?: NodeJS.ProcessEnv;
  authSource?: CodexAuthSource;
};

export function createBureauAgentProvider(
  options: CreateBureauAgentProviderOptions,
): AgentProvider {
  const env = options.env ?? process.env;

  if (options.sandboxProvider.name === "remote-container") {
    return createRemoteBureauProvider({
      runtime: env.BUREAU_SANDBOX_RUNTIME === "podman" ? "podman" : "docker",
      image: env.BUREAU_RUNTIME_IMAGE ?? env.BUREAU_SANDBOX_IMAGE ?? "oven/bun:1",
      repoRoot: options.repoRoot,
    });
  }

  return createPiProvider({
    authSource: options.authSource ?? createFileCodexAuthSource(),
  });
}
