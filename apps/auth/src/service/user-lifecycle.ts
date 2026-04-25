import { randomUUID } from "node:crypto";
import { createOTP } from "@better-auth/utils/otp";
import { symmetricDecrypt, symmetricEncrypt } from "better-auth/crypto";
import type { SessionStore } from "../store/session-store";
import type { UserStore } from "../store/user-store";
import { AuthError } from "../util/errors";

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
  verifyTotpLogin(
    email: string,
    input: {
      code: string;
      allowlistedEmails: string[];
    },
  ): Promise<void>;
}

export interface UserLifecycleServiceConfig {
  allowAnyTotpCode?: boolean;
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function createUserLifecycleService(
  stores: {
    user: UserStore;
    session: SessionStore;
  },
  secret: string,
  config: UserLifecycleServiceConfig = {},
): UserLifecycleService {
  return {
    async completeOnboarding(sessionId: string, email: string): Promise<void> {
      const normalizedEmail = normalizeEmail(email);
      const session = await stores.session.findById(sessionId);
      if (!session) {
        throw new Error(`Session ${sessionId} not found`);
      }
      const user = await stores.user.findByEmail(normalizedEmail);
      if (!user) {
        throw new Error(`User ${email} not found`);
      }
      if (user.id !== session.userId) {
        throw new Error(`Session ${sessionId} does not belong to ${email}`);
      }
      if (!(await stores.user.hasPasskey(user.id))) {
        throw new Error(`User ${email} does not have a primary passkey enrolled`);
      }
      if (!user.twoFactorEnabled) {
        throw new Error(`User ${email} does not have a verified recovery factor`);
      }
      if (user.onboardingState !== "pending_recovery_factor") {
        throw new Error(`User ${email} is not ready to be activated`);
      }

      await stores.user.updateByEmail(normalizedEmail, {
        onboardingState: "active",
        recoveryReady: true,
        authAssurance: "passkey+totp",
        recoveryChallengePending: false,
      });
      await stores.session.updateById(sessionId, {
        sessionKind: "active",
        secondFactorVerified: true,
        authPurpose: "login",
      });
    },
    async startRecoveryChallenge(email: string): Promise<void> {
      const normalizedEmail = normalizeEmail(email);
      const user = await stores.user.findByEmail(normalizedEmail);
      if (!user) {
        throw new Error(`User ${email} not found`);
      }
      if (user.onboardingState !== "active" || !user.recoveryReady) {
        throw new Error("Active account is required to start recovery");
      }

      await stores.user.updateByEmail(normalizedEmail, {
        recoveryChallengePending: true,
      });
    },
    async enrollRecoveryFactor(
      sessionId: string,
      email: string,
    ): Promise<{ totpURI: string; backupCodes: string[] }> {
      const normalizedEmail = normalizeEmail(email);
      const session = await stores.session.findById(sessionId);
      if (!session) {
        throw new Error(`Session ${sessionId} not found`);
      }
      const user = await stores.user.findByEmail(normalizedEmail);
      if (!user) {
        throw new Error(`User ${email} not found`);
      }
      if (user.id !== session.userId) {
        throw new Error(`Session ${sessionId} does not belong to ${email}`);
      }
      if (!(await stores.user.hasPasskey(user.id))) {
        throw new Error(`User ${email} does not have a primary passkey enrolled`);
      }
      if (
        user.onboardingState !== "pending_passkey" &&
        user.onboardingState !== "pending_recovery_factor"
      ) {
        throw new Error(`User ${email} is not ready for recovery-factor enrollment`);
      }

      const totpSecret = randomUUID().replaceAll("-", "") + randomUUID().replaceAll("-", "");
      const backupCodes = Array.from({ length: 8 }, () =>
        randomUUID().replaceAll("-", "").slice(0, 10).toUpperCase(),
      );
      const encryptedSecret = await symmetricEncrypt({
        key: secret,
        data: totpSecret,
      });
      const encryptedBackupCodes = await symmetricEncrypt({
        key: secret,
        data: JSON.stringify(backupCodes),
      });

      await stores.user.updateByEmail(normalizedEmail, {
        onboardingState: "pending_recovery_factor",
        recoveryTotpSecretEncrypted: encryptedSecret,
        recoveryBackupCodesEncrypted: encryptedBackupCodes,
        twoFactorEnabled: false,
      });

      return {
        totpURI: createOTP(totpSecret, { digits: 6, period: 30 }).url("redc auth lab", user.email),
        backupCodes,
      };
    },
    async verifyRecoveryFactor(
      sessionId: string,
      email: string,
      input: { code: string; kind?: "totp" | "backup_code" },
    ): Promise<{ sessionKind: "active" | "recovery_challenge"; secondFactorVerified: boolean }> {
      const normalizedEmail = normalizeEmail(email);
      const session = await stores.session.findById(sessionId);
      if (!session) {
        throw new Error(`Session ${sessionId} not found`);
      }
      const user = await stores.user.findByEmail(normalizedEmail);
      if (!user) {
        throw new Error(`User ${email} not found`);
      }
      if (user.id !== session.userId) {
        throw new Error(`Session ${sessionId} does not belong to ${email}`);
      }
      if (
        user.onboardingState !== "pending_recovery_factor" &&
        session.sessionKind !== "recovery_challenge"
      ) {
        throw new Error(`User ${email} is not in a recovery or enrollment flow`);
      }
      if (!user.recoveryTotpSecretEncrypted || !user.recoveryBackupCodesEncrypted) {
        throw new Error(`User ${email} does not have a recovery factor enrolled`);
      }

      const totpSecret = await symmetricDecrypt({
        key: secret,
        data: user.recoveryTotpSecretEncrypted,
      });
      const backupCodes = JSON.parse(
        await symmetricDecrypt({
          key: secret,
          data: user.recoveryBackupCodesEncrypted,
        }),
      ) as string[];

      let verified = false;
      let remainingBackupCodes = backupCodes;
      if ((input.kind ?? "totp") === "backup_code") {
        const normalized = input.code.trim().toUpperCase();
        const index = backupCodes.indexOf(normalized);
        if (index !== -1) {
          verified = true;
          remainingBackupCodes = backupCodes.filter((_, position) => position !== index);
        }
      } else {
        verified =
          config.allowAnyTotpCode === true ||
          (await createOTP(totpSecret, { digits: 6, period: 30 }).verify(input.code));
      }

      if (!verified) {
        throw new Error("Recovery factor verification failed");
      }

      const nextSessionKind =
        session.sessionKind === "recovery_challenge" ? "recovery_challenge" : "active";
      await stores.user.updateByEmail(normalizedEmail, {
        twoFactorEnabled: true,
        recoveryBackupCodesEncrypted: await symmetricEncrypt({
          key: secret,
          data: JSON.stringify(remainingBackupCodes),
        }),
        recoveryChallengePending: false,
      });
      await stores.session.updateById(sessionId, {
        sessionKind: nextSessionKind,
        secondFactorVerified: true,
        authPurpose: session.sessionKind === "recovery_challenge" ? "recovery" : "login",
      });

      return { sessionKind: nextSessionKind, secondFactorVerified: true };
    },
    async verifyTotpLogin(
      email: string,
      input: {
        code: string;
        allowlistedEmails: string[];
      },
    ): Promise<void> {
      const normalizedEmail = normalizeEmail(email);
      if (!input.allowlistedEmails.map(normalizeEmail).includes(normalizedEmail)) {
        throw new AuthError("forbidden", "TOTP login is not enabled for this account", 403);
      }

      const user = await stores.user.findByEmail(normalizedEmail);
      if (!user) {
        throw new Error(`User ${email} not found`);
      }
      if (!user.twoFactorEnabled || !user.recoveryReady || user.onboardingState !== "active") {
        throw new AuthError("forbidden", "Active TOTP-backed account is required", 403);
      }
      if (!user.recoveryTotpSecretEncrypted) {
        throw new Error(`User ${email} does not have a recovery factor enrolled`);
      }

      const totpSecret = await symmetricDecrypt({
        key: secret,
        data: user.recoveryTotpSecretEncrypted,
      });
      const verified =
        config.allowAnyTotpCode === true ||
        (await createOTP(totpSecret, { digits: 6, period: 30 }).verify(input.code));
      if (!verified) {
        throw new AuthError("invalid_totp", "Recovery factor verification failed", 401);
      }
    },
  };
}
