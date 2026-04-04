/**
 * Test fixture for the user auth lifecycle policy.
 *
 * This file is intentionally test-only and models the policy spec, not the
 * runtime implementation.
 */
import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { AuthLabError } from "../../../utils/errors";
import type {
  UserAccountState,
  UserMagicLinkPurpose,
  UserRecoveryFactorKind,
  UserSessionKind,
} from "../../../utils/types";

export interface MagicLinkChallenge {
  token: string;
  email: string;
  purpose: UserMagicLinkPurpose;
  expiresAt: number;
}

export interface UserSession {
  id: string;
  userId: string;
  email: string;
  kind: UserSessionKind;
  magicLinkVerified: boolean;
  secondFactorVerified: boolean;
  createdAt: string;
}

export interface TotpEnrollment {
  totpSecret: string;
  backupCodes: string[];
}

export type RecoveryAssertion =
  | { kind: "totp"; code: string }
  | { kind: "backup_code"; code: string };

export interface UserUser {
  id: string;
  email: string;
  state: UserAccountState;
  passkeys: string[];
  totpSecret?: string;
  backupCodes: string[];
  createdAt: string;
  updatedAt: string;
}

interface StoredMagicLinkChallenge extends MagicLinkChallenge {
  used: boolean;
}

interface StoredSession extends UserSession {
  verifiedRecoveryAssertion?: boolean;
}

interface UserAuthPolicyState {
  usersById: Map<string, UserUser>;
  usersByEmail: Map<string, string>;
  challengesByToken: Map<string, StoredMagicLinkChallenge>;
  sessionsById: Map<string, StoredSession>;
}

function nowIso(): string {
  return new Date().toISOString();
}

function normalizeCode(code: string): string {
  return code.trim().toUpperCase();
}

export function generateBackupCodes(count = 8): string[] {
  return Array.from({ length: count }, () => randomBytes(4).toString("hex").toUpperCase());
}

export function generateTotpCode(secret: string, timestampMs = Date.now()): string {
  const counter = Math.floor(timestampMs / 30_000);
  const buffer = Buffer.alloc(8);
  buffer.writeBigUInt64BE(BigInt(counter));
  const digest = createHmac("sha1", secret).update(buffer).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const binary =
    ((digest[offset] & 0x7f) << 24) |
    ((digest[offset + 1] & 0xff) << 16) |
    ((digest[offset + 2] & 0xff) << 8) |
    (digest[offset + 3] & 0xff);
  return String(binary % 1_000_000).padStart(6, "0");
}

function verifyTotpCode(secret: string, code: string): boolean {
  const normalized = code.trim();
  for (const offset of [-1, 0, 1]) {
    const candidate = generateTotpCode(secret, Date.now() + offset * 30_000);
    if (candidate === normalized) {
      return true;
    }
  }
  return false;
}

function createUser(email: string): UserUser {
  const timestamp = nowIso();
  return {
    id: randomUUID(),
    email,
    state: "pending_passkey",
    passkeys: [],
    backupCodes: [],
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

function touch(user: UserUser): UserUser {
  return {
    ...user,
    updatedAt: nowIso(),
  };
}

function requireSession(state: UserAuthPolicyState, sessionId: string): StoredSession {
  const session = state.sessionsById.get(sessionId);
  if (!session) {
    throw new AuthLabError("invalid_session", "Unknown session", 401);
  }
  return session;
}

function requireUser(state: UserAuthPolicyState, email: string): UserUser {
  const userId = state.usersByEmail.get(email);
  if (!userId) {
    throw new AuthLabError("unknown_user", "User does not exist", 404);
  }
  const user = state.usersById.get(userId);
  if (!user) {
    throw new AuthLabError("unknown_user", "User does not exist", 404);
  }
  return user;
}

function persistUser(state: UserAuthPolicyState, user: UserUser): UserUser {
  const next = touch(user);
  state.usersById.set(next.id, next);
  state.usersByEmail.set(next.email, next.id);
  return next;
}

function canPerformAccountRecoveryAction(session: StoredSession): boolean {
  return (
    session.kind === "active" ||
    (session.kind === "recovery_challenge" && session.secondFactorVerified)
  );
}

export interface UserAuthPolicy {
  requestMagicLink(email: string): MagicLinkChallenge;
  verifyMagicLink(token: string): UserSession;
  authenticateWithPasskey(email: string, passkeyId: string): UserSession;
  registerPrimaryPasskey(sessionId: string, passkeyId: string): UserUser;
  enrollRecoveryBundle(sessionId: string, input: TotpEnrollment): UserUser;
  verifyRecoveryFactor(sessionId: string, assertion: RecoveryAssertion): UserSession;
  resetPrimaryPasskeys(sessionId: string): UserUser;
  disableRecoveryFactor(sessionId: string, factorKind: UserRecoveryFactorKind): UserUser;
  changeEmail(sessionId: string, newEmail: string): UserUser;
  getUserByEmail(email: string): UserUser | undefined;
  getSession(sessionId: string): UserSession | undefined;
}

export function createUserAuthPolicy(): UserAuthPolicy {
  // TODO: Replace this in-memory state with a real DB-backed store before production use.
  // Users, sessions, magic-link challenges, TOTP secrets, and backup-code consumption must persist across restarts.
  const state: UserAuthPolicyState = {
    usersById: new Map(),
    usersByEmail: new Map(),
    challengesByToken: new Map(),
    sessionsById: new Map(),
  };

  const ensureChallenge = (token: string): StoredMagicLinkChallenge => {
    const challenge = state.challengesByToken.get(token);
    if (!challenge) {
      throw new AuthLabError("invalid_magic_link", "Unknown magic link", 401);
    }
    if (challenge.used) {
      throw new AuthLabError("invalid_magic_link", "Magic link already used", 401);
    }
    if (challenge.expiresAt < Date.now()) {
      throw new AuthLabError("invalid_magic_link", "Magic link expired", 401);
    }
    return challenge;
  };

  return {
    requestMagicLink(email: string) {
      const normalizedEmail = email.trim().toLowerCase();
      if (!normalizedEmail) {
        throw new AuthLabError("invalid_request", "Email is required", 400);
      }

      const userId = state.usersByEmail.get(normalizedEmail);
      const user = userId ? state.usersById.get(userId) : undefined;
      if (!user) {
        const created = createUser(normalizedEmail);
        state.usersById.set(created.id, created);
        state.usersByEmail.set(created.email, created.id);
      }

      const purpose = user?.state === "active" ? "recovery" : "bootstrap";
      const token = randomBytes(32).toString("base64url");
      state.challengesByToken.set(token, {
        token,
        email: normalizedEmail,
        purpose,
        expiresAt: Date.now() + 15 * 60_000,
        used: false,
      });

      return {
        token,
        email: normalizedEmail,
        purpose,
        expiresAt: Date.now() + 15 * 60_000,
      };
    },

    verifyMagicLink(token: string) {
      const challenge = ensureChallenge(token);
      challenge.used = true;

      const user = requireUser(state, challenge.email);
      const session: StoredSession = {
        id: randomUUID(),
        userId: user.id,
        email: user.email,
        kind: challenge.purpose === "recovery" ? "recovery_challenge" : "bootstrap",
        magicLinkVerified: true,
        secondFactorVerified: false,
        createdAt: nowIso(),
      };
      state.sessionsById.set(session.id, session);
      return session;
    },

    authenticateWithPasskey(email: string, passkeyId: string) {
      const user = requireUser(state, email.trim().toLowerCase());
      if (user.state !== "active") {
        throw new AuthLabError("account_not_active", "Passkey login is not available yet", 403);
      }
      if (!user.passkeys.includes(passkeyId)) {
        throw new AuthLabError("invalid_passkey", "Unknown passkey", 401);
      }

      const session: StoredSession = {
        id: randomUUID(),
        userId: user.id,
        email: user.email,
        kind: "active",
        magicLinkVerified: false,
        secondFactorVerified: true,
        createdAt: nowIso(),
      };
      state.sessionsById.set(session.id, session);
      return session;
    },

    registerPrimaryPasskey(sessionId: string, passkeyId: string) {
      const session = requireSession(state, sessionId);
      if (session.kind !== "bootstrap" || !session.magicLinkVerified) {
        throw new AuthLabError("forbidden", "Magic-link bootstrap session required", 403);
      }

      const user = state.usersById.get(session.userId);
      if (!user || user.state !== "pending_passkey") {
        throw new AuthLabError("forbidden", "Account is not waiting for first passkey", 403);
      }
      if (user.passkeys.includes(passkeyId)) {
        throw new AuthLabError("conflict", "Passkey already exists", 409);
      }

      user.passkeys.push(passkeyId);
      user.state = "pending_recovery_factor";
      const next = persistUser(state, user);
      return next;
    },

    enrollRecoveryBundle(sessionId: string, input: TotpEnrollment) {
      const session = requireSession(state, sessionId);
      if (session.kind !== "bootstrap" || !session.magicLinkVerified) {
        throw new AuthLabError("forbidden", "Bootstrap session required", 403);
      }
      const user = state.usersById.get(session.userId);
      if (!user || user.state !== "pending_recovery_factor") {
        throw new AuthLabError("forbidden", "Account is not waiting for recovery enrollment", 403);
      }
      if (!user.passkeys.length) {
        throw new AuthLabError("forbidden", "Primary passkey required first", 403);
      }
      if (!input.totpSecret.trim()) {
        throw new AuthLabError("invalid_request", "TOTP secret is required", 400);
      }
      if (!input.backupCodes.length) {
        throw new AuthLabError("invalid_request", "At least one backup code is required", 400);
      }

      user.totpSecret = input.totpSecret;
      user.backupCodes = input.backupCodes.map(normalizeCode);
      user.state = "active";
      const next = persistUser(state, user);
      return next;
    },

    verifyRecoveryFactor(sessionId: string, assertion: RecoveryAssertion) {
      const session = requireSession(state, sessionId);
      if (session.kind !== "recovery_challenge" || !session.magicLinkVerified) {
        throw new AuthLabError("forbidden", "Recovery challenge session required", 403);
      }

      const user = state.usersById.get(session.userId);
      if (!user || user.state !== "active") {
        throw new AuthLabError("forbidden", "Account is not active", 403);
      }
      if (!user.totpSecret && user.backupCodes.length === 0) {
        throw new AuthLabError("forbidden", "Recovery factors are not enrolled", 403);
      }

      const success =
        assertion.kind === "totp"
          ? Boolean(user.totpSecret && verifyTotpCode(user.totpSecret, assertion.code))
          : (() => {
              // TODO: Consume backup codes transactionally in the database so one-time use remains correct under concurrency.
              const normalized = normalizeCode(assertion.code);
              const index = user.backupCodes.indexOf(normalized);
              if (index === -1) return false;
              user.backupCodes.splice(index, 1);
              return true;
            })();

      if (!success) {
        throw new AuthLabError(
          "invalid_recovery_factor",
          "Recovery factor verification failed",
          401,
        );
      }

      session.secondFactorVerified = true;
      session.verifiedRecoveryAssertion = true;
      state.sessionsById.set(session.id, session);
      return session;
    },

    resetPrimaryPasskeys(sessionId: string) {
      const session = requireSession(state, sessionId);
      if (!canPerformAccountRecoveryAction(session)) {
        throw new AuthLabError("forbidden", "Second-factor recovery is required", 403);
      }

      const user = state.usersById.get(session.userId);
      if (!user) {
        throw new AuthLabError("unknown_user", "User does not exist", 404);
      }

      user.passkeys = [];
      user.state = "pending_passkey";
      return persistUser(state, user);
    },

    disableRecoveryFactor(sessionId: string, factorKind: UserRecoveryFactorKind) {
      const session = requireSession(state, sessionId);
      if (!canPerformAccountRecoveryAction(session)) {
        throw new AuthLabError("forbidden", "Second-factor recovery is required", 403);
      }

      const user = state.usersById.get(session.userId);
      if (!user) {
        throw new AuthLabError("unknown_user", "User does not exist", 404);
      }

      const nextTotpSecret = factorKind === "totp" ? undefined : user.totpSecret;
      const nextBackupCodes = factorKind === "backup_code" ? [] : [...user.backupCodes];
      if (!nextTotpSecret && nextBackupCodes.length === 0) {
        throw new AuthLabError("forbidden", "At least one recovery factor must remain", 403);
      }

      if (factorKind === "totp") {
        user.totpSecret = undefined;
      } else {
        user.backupCodes = [];
      }

      return persistUser(state, user);
    },

    changeEmail(sessionId: string, newEmail: string) {
      const session = requireSession(state, sessionId);
      if (!canPerformAccountRecoveryAction(session)) {
        throw new AuthLabError("forbidden", "Second-factor recovery is required", 403);
      }

      const normalizedEmail = newEmail.trim().toLowerCase();
      if (!normalizedEmail) {
        throw new AuthLabError("invalid_request", "Email is required", 400);
      }
      if (state.usersByEmail.has(normalizedEmail)) {
        throw new AuthLabError("conflict", "Email is already in use", 409);
      }

      const user = state.usersById.get(session.userId);
      if (!user) {
        throw new AuthLabError("unknown_user", "User does not exist", 404);
      }

      state.usersByEmail.delete(user.email);
      user.email = normalizedEmail;
      state.usersByEmail.set(normalizedEmail, user.id);
      return persistUser(state, user);
    },

    getUserByEmail(email: string) {
      const userId = state.usersByEmail.get(email.trim().toLowerCase());
      return userId ? state.usersById.get(userId) : undefined;
    },

    getSession(sessionId: string) {
      return state.sessionsById.get(sessionId);
    },
  };
}
