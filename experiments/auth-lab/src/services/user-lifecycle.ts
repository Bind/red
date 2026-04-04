import type { UserAuthRuntime } from "../user-auth-runtime";

export interface UserLifecycleService {
  completeOnboarding(sessionId: string, email: string): Promise<void>;
  startRecoveryChallenge(email: string): Promise<void>;
  enrollRecoveryFactor(
    sessionId: string,
    email: string,
  ): Promise<{ totpURI: string; backupCodes: string[] }>;
  verifyRecoveryFactor(
    sessionId: string,
    email: string,
    input: { code: string; kind?: "totp" | "backup_code" },
  ): Promise<{ sessionKind: "active" | "recovery_challenge"; secondFactorVerified: boolean }>;
}

export function createUserLifecycleService(runtime: UserAuthRuntime): UserLifecycleService {
  return {
    completeOnboarding(sessionId: string, email: string): Promise<void> {
      return runtime.promoteAccountToActiveBySession(sessionId, email);
    },
    startRecoveryChallenge(email: string): Promise<void> {
      return runtime.startRecoveryChallengeByEmail(email);
    },
    enrollRecoveryFactor(
      sessionId: string,
      email: string,
    ): Promise<{ totpURI: string; backupCodes: string[] }> {
      return runtime.enrollRecoveryFactorBySession(sessionId, email);
    },
    verifyRecoveryFactor(
      sessionId: string,
      email: string,
      input: { code: string; kind?: "totp" | "backup_code" },
    ): Promise<{ sessionKind: "active" | "recovery_challenge"; secondFactorVerified: boolean }> {
      return runtime.verifyRecoveryFactorBySession(sessionId, email, input);
    },
  };
}
