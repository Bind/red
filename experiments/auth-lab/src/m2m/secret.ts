import { pbkdf2Sync, randomBytes, timingSafeEqual } from "node:crypto";

const ITERATIONS = 150_000;
const KEY_LENGTH = 32;

export function generateClientSecret(): string {
  return randomBytes(24).toString("base64url");
}

export function hashClientSecret(secret: string): string {
  const salt = randomBytes(16);
  const derived = pbkdf2Sync(secret, salt, ITERATIONS, KEY_LENGTH, "sha256");
  return [
    "pbkdf2_sha256",
    ITERATIONS.toString(10),
    salt.toString("base64url"),
    derived.toString("base64url"),
  ].join("$");
}

export function verifyClientSecret(secret: string, encodedHash: string): boolean {
  const [algorithm, iterationsText, saltText, hashText] = encodedHash.split("$");
  if (algorithm !== "pbkdf2_sha256") {
    throw new Error(`Unsupported secret hash algorithm: ${algorithm}`);
  }

  const iterations = Number.parseInt(iterationsText ?? "", 10);
  if (!Number.isFinite(iterations) || iterations <= 0) {
    throw new Error(`Invalid secret hash iterations: ${iterationsText}`);
  }

  const salt = Buffer.from(saltText ?? "", "base64url");
  const expected = Buffer.from(hashText ?? "", "base64url");
  const actual = pbkdf2Sync(secret, salt, iterations, expected.length, "sha256");
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}
