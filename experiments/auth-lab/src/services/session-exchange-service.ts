import type {
  BetterAuthAdapter,
  BetterAuthSessionRecord,
  BetterAuthSessionUser,
} from "../adapters/better-auth-adapter";
import { AuthLabError } from "../errors";
import type { SessionExchangeTokenResponse } from "../m2m/token-service";

export interface SessionExchangeAuthority {
  issueSessionExchangeToken(input: {
    subject: string;
    sid: string;
    email: string;
    amr: string[];
    onboardingState: string;
    recoveryReady: boolean;
    scope: string;
  }): Promise<SessionExchangeTokenResponse>;
}

export interface SessionExchangeResult {
  body: SessionExchangeTokenResponse;
  headers: Headers;
}

function normalizeString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function normalizeBoolean(value: unknown): boolean {
  return value === true;
}

function collectSessionAmr(
  session: BetterAuthSessionRecord,
  user: BetterAuthSessionUser,
): string[] {
  const amr = new Set<string>();
  const onboardingState = normalizeString(user.onboardingState) ?? "pending_passkey";
  const recoveryReady = normalizeBoolean(user.recoveryReady);
  const recoveryChallengePending = normalizeBoolean(user.recoveryChallengePending);
  const authAssurance = normalizeString(user.authAssurance);
  const sessionKind = normalizeString(session.sessionKind);
  const secondFactorVerified = normalizeBoolean(session.secondFactorVerified);

  if (
    sessionKind === "bootstrap" ||
    onboardingState === "pending_passkey" ||
    recoveryChallengePending
  ) {
    amr.add("magic_link");
  }
  if (sessionKind === "recovery_challenge") {
    amr.add("magic_link");
  }
  if (authAssurance?.includes("passkey") || sessionKind === "active") {
    amr.add("passkey");
  }
  if (secondFactorVerified || recoveryReady) {
    amr.add("mfa");
  }
  if (amr.size === 0) {
    amr.add("session");
  }
  return [...amr];
}

export function createSessionExchangeService(
  auth: BetterAuthAdapter,
  authority: SessionExchangeAuthority,
): {
  exchange(request: Request): Promise<SessionExchangeResult>;
} {
  return {
    async exchange(request: Request): Promise<SessionExchangeResult> {
      const sessionResult = await auth.getSession(request);
      if (!sessionResult.response) {
        throw new AuthLabError("invalid_session", "A valid authenticated session is required", 401);
      }

      const { session, user } = sessionResult.response;
      const onboardingState = normalizeString(user.onboardingState) ?? "pending_passkey";
      const recoveryReady = normalizeBoolean(user.recoveryReady);
      const recoveryChallengePending = normalizeBoolean(user.recoveryChallengePending);
      const sessionKind = normalizeString(session.sessionKind);
      const secondFactorVerified = normalizeBoolean(session.secondFactorVerified);

      if (onboardingState !== "active" || !recoveryReady) {
        throw new AuthLabError("forbidden", "Active account state is required", 403);
      }
      if (recoveryChallengePending && !secondFactorVerified) {
        throw new AuthLabError(
          "forbidden",
          "Recovery challenge sessions require a second factor before exchange",
          403,
        );
      }
      if (sessionKind === "bootstrap") {
        throw new AuthLabError("forbidden", "Bootstrap sessions cannot receive service JWTs", 403);
      }
      if (sessionKind === "recovery_challenge" && !secondFactorVerified) {
        throw new AuthLabError(
          "forbidden",
          "Recovery challenge sessions require a second factor before exchange",
          403,
        );
      }

      const body = await authority.issueSessionExchangeToken({
        subject: `user:${user.id}`,
        sid: session.id,
        email: user.email,
        amr: collectSessionAmr(session, user),
        onboardingState,
        recoveryReady,
        scope: "session:exchange",
      });

      return { body, headers: sessionResult.headers };
    },
  };
}
