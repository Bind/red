export type UserAccountState = "pending_passkey" | "pending_recovery_factor" | "active";
export type UserSessionKind = "bootstrap" | "recovery_challenge" | "active";
export type UserMagicLinkPurpose = "bootstrap" | "recovery";
export type UserRecoveryFactorKind = "totp" | "backup_code";
