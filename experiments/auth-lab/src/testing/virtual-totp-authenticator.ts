/**
 * Test-only virtual TOTP authenticator.
 *
 * Narrow scope:
 * - RFC6238-style TOTP
 * - SHA-1 only
 * - 30 second step
 * - 6 digits
 * - raw shared secret string
 *
 * This exists to drive auth-lab tests without a real OTP app or browser.
 */
import { createHmac, randomBytes } from "node:crypto";

export interface VirtualTotpAuthenticatorConfig {
  digits?: number;
  periodSeconds?: number;
}

export interface VirtualTotpAuthenticator {
  createSecret(): string;
  createCode(secret: string, timestampMs?: number): string;
  verifyCode(secret: string, code: string, timestampMs?: number, window?: number): boolean;
}

function counterAt(timestampMs: number, periodSeconds: number): bigint {
  return BigInt(Math.floor(timestampMs / (periodSeconds * 1_000)));
}

function hotp(secret: string, counter: bigint, digits: number): string {
  const buffer = Buffer.alloc(8);
  buffer.writeBigUInt64BE(counter, 0);
  const digest = createHmac("sha1", secret).update(buffer).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const binary =
    ((digest[offset] & 0x7f) << 24) |
    ((digest[offset + 1] & 0xff) << 16) |
    ((digest[offset + 2] & 0xff) << 8) |
    (digest[offset + 3] & 0xff);
  return String(binary % 10 ** digits).padStart(digits, "0");
}

export function createVirtualTotpAuthenticator(
  config: VirtualTotpAuthenticatorConfig = {}
): VirtualTotpAuthenticator {
  const digits = config.digits ?? 6;
  const periodSeconds = config.periodSeconds ?? 30;

  return {
    createSecret(): string {
      return randomBytes(32).toString("base64url");
    },
    createCode(secret: string, timestampMs = Date.now()): string {
      return hotp(secret, counterAt(timestampMs, periodSeconds), digits);
    },
    verifyCode(secret: string, code: string, timestampMs = Date.now(), window = 1): boolean {
      const currentCounter = counterAt(timestampMs, periodSeconds);
      for (let offset = -window; offset <= window; offset += 1) {
        const candidateCounter = currentCounter + BigInt(offset);
        if (candidateCounter < 0n) {
          continue;
        }
        if (hotp(secret, candidateCounter, digits) === code.trim()) {
          return true;
        }
      }
      return false;
    },
  };
}
