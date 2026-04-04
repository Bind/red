export interface UserAuthScaffoldConfig {
  issuer: string;
}

export interface UserAuthScaffold {
  kind: "scaffold";
  issuer: string;
  provider: "better-auth";
  plannedPlugins: readonly ["magic-link", "passkey", "2fa", "jwt"];
  notes: readonly string[];
}

export function createUserAuthScaffold(config: UserAuthScaffoldConfig): UserAuthScaffold {
  return {
    kind: "scaffold",
    issuer: config.issuer,
    provider: "better-auth",
    plannedPlugins: ["magic-link", "passkey", "2fa", "jwt"],
    notes: [
      "This file only describes the policy scaffold.",
      "The mounted Better Auth runtime lives in user-auth-runtime.ts.",
    ],
  };
}
