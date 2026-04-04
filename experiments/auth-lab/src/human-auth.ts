export interface HumanAuthScaffoldConfig {
  issuer: string;
}

export interface HumanAuthScaffold {
  kind: "scaffold";
  issuer: string;
  provider: "better-auth";
  plannedPlugins: readonly ["magic-link", "passkey", "2fa", "jwt"];
  notes: readonly string[];
}

export function createHumanAuthScaffold(config: HumanAuthScaffoldConfig): HumanAuthScaffold {
  return {
    kind: "scaffold",
    issuer: config.issuer,
    provider: "better-auth",
    plannedPlugins: ["magic-link", "passkey", "2fa", "jwt"],
    notes: [
      "This file only describes the policy scaffold.",
      "The mounted Better Auth runtime lives in human-auth-runtime.ts.",
    ],
  };
}
