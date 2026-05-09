import {
  createFileCodexAuthSource,
  createPiProvider,
  type AgentProvider,
  type CodexAuthSource,
} from "../pkg/daemons/src/index";
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
  if (options.sandboxProvider.kind === "remote") {
    throw new Error(
      "createBureauAgentProvider does not auto-wire remote sandboxes yet; provide an explicit remote AgentProvider instead",
    );
  }

  return createPiProvider({
    authSource: options.authSource ?? createFileCodexAuthSource(),
  });
}
