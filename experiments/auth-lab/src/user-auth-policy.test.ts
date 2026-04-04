import { describe, expect, test } from "bun:test";
import { createUserAuthPolicy, generateBackupCodes, generateTotpCode } from "./user-auth-policy";

function bootstrapActiveUser(email = "alice@example.com") {
  const policy = createUserAuthPolicy();
  const challenge = policy.requestMagicLink(email);
  const bootstrapSession = policy.verifyMagicLink(challenge.token);
  policy.registerPrimaryPasskey(bootstrapSession.id, "passkey-1");

  const backupCodes = generateBackupCodes(3);
  policy.enrollRecoveryBundle(bootstrapSession.id, {
    totpSecret: "totp-secret",
    backupCodes,
  });

  return {
    policy,
    email,
    backupCodes,
  };
}

describe("user auth policy", () => {
  test("new user cannot register first passkey without successful magic link", () => {
    const policy = createUserAuthPolicy();

    expect(() => policy.registerPrimaryPasskey("missing-session", "passkey-1")).toThrow(
      /Unknown session/,
    );
  });

  test("new user can register first passkey after successful magic link", () => {
    const policy = createUserAuthPolicy();
    const challenge = policy.requestMagicLink("new@example.com");
    const session = policy.verifyMagicLink(challenge.token);

    const user = policy.registerPrimaryPasskey(session.id, "passkey-1");

    expect(user.state).toBe("pending_recovery_factor");
    expect(user.passkeys).toEqual(["passkey-1"]);
  });

  test("new user cannot reach full active state before recovery enrollment", () => {
    const policy = createUserAuthPolicy();
    const challenge = policy.requestMagicLink("new@example.com");
    const session = policy.verifyMagicLink(challenge.token);
    policy.registerPrimaryPasskey(session.id, "passkey-1");

    expect(policy.getUserByEmail("new@example.com")?.state).toBe("pending_recovery_factor");
  });

  test("recovery session without second factor cannot access protected account-recovery actions", () => {
    const { policy, email } = bootstrapActiveUser();
    const recoveryChallenge = policy.requestMagicLink(email);
    const recoverySession = policy.verifyMagicLink(recoveryChallenge.token);

    expect(() => policy.resetPrimaryPasskeys(recoverySession.id)).toThrow(/Second-factor recovery/);
    expect(() => policy.disableRecoveryFactor(recoverySession.id, "totp")).toThrow(
      /Second-factor recovery/,
    );
    expect(() => policy.changeEmail(recoverySession.id, "attacker@example.com")).toThrow(
      /Second-factor recovery/,
    );
  });

  test("existing active user with magic link plus recovery factor succeeds", () => {
    const { policy, email, backupCodes } = bootstrapActiveUser();
    const recoveryChallenge = policy.requestMagicLink(email);
    const recoverySession = policy.verifyMagicLink(recoveryChallenge.token);

    policy.verifyRecoveryFactor(recoverySession.id, {
      kind: "totp",
      code: generateTotpCode("totp-secret"),
    });

    const updated = policy.changeEmail(recoverySession.id, "alice.new@example.com");
    expect(updated.email).toBe("alice.new@example.com");

    const rotated = policy.resetPrimaryPasskeys(recoverySession.id);
    expect(rotated.passkeys).toEqual([]);

    const stillEnrolled = policy.disableRecoveryFactor(recoverySession.id, "backup_code");
    expect(stillEnrolled.state).toBe("pending_passkey");

    expect(policy.requestMagicLink("alice.new@example.com").purpose).toBe("bootstrap");
    expect(backupCodes.length).toBeGreaterThan(0);
  });

  test("existing active user recovery with magic link alone is denied", () => {
    const { policy, email } = bootstrapActiveUser();
    const recoveryChallenge = policy.requestMagicLink(email);
    const recoverySession = policy.verifyMagicLink(recoveryChallenge.token);

    expect(() => policy.changeEmail(recoverySession.id, "alice.new@example.com")).toThrow(
      /Second-factor recovery/,
    );
  });

  test("attacker with email access only cannot reset existing user passkey", () => {
    const { policy, email } = bootstrapActiveUser();
    const recoveryChallenge = policy.requestMagicLink(email);
    const recoverySession = policy.verifyMagicLink(recoveryChallenge.token);

    expect(() => policy.resetPrimaryPasskeys(recoverySession.id)).toThrow(/Second-factor recovery/);
  });

  test("attacker with email access only cannot disable recovery factor", () => {
    const { policy, email } = bootstrapActiveUser();
    const recoveryChallenge = policy.requestMagicLink(email);
    const recoverySession = policy.verifyMagicLink(recoveryChallenge.token);

    expect(() => policy.disableRecoveryFactor(recoverySession.id, "backup_code")).toThrow(
      /Second-factor recovery/,
    );
  });

  test("attacker with email access only cannot change account email", () => {
    const { policy, email } = bootstrapActiveUser();
    const recoveryChallenge = policy.requestMagicLink(email);
    const recoverySession = policy.verifyMagicLink(recoveryChallenge.token);

    expect(() => policy.changeEmail(recoverySession.id, "attacker@example.com")).toThrow(
      /Second-factor recovery/,
    );
  });

  test("backup code is one-time use", () => {
    const { policy, email, backupCodes } = bootstrapActiveUser();
    const code = backupCodes[0];

    const firstChallenge = policy.verifyMagicLink(policy.requestMagicLink(email).token);
    policy.verifyRecoveryFactor(firstChallenge.id, {
      kind: "backup_code",
      code,
    });

    const secondChallenge = policy.verifyMagicLink(policy.requestMagicLink(email).token);
    expect(() =>
      policy.verifyRecoveryFactor(secondChallenge.id, {
        kind: "backup_code",
        code,
      }),
    ).toThrow(/Recovery factor verification failed/);
  });
});
