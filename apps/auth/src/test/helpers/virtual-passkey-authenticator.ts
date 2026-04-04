/**
 * Test-only virtual WebAuthn authenticator.
 *
 * Narrow scope:
 * - ES256 only
 * - attestation format: "none"
 * - in-memory credential storage
 * - one origin / RP ID per instance
 * - user verification treated as enabled by default
 *
 * This exists purely to drive auth-lab tests without a browser.
 */
import { createHash, generateKeyPairSync, type KeyObject, randomBytes, sign } from "node:crypto";
import { type CBORType, encodeCBOR } from "@levischuck/tiny-cbor";
import type {
  AuthenticationResponseJSON,
  AuthenticatorTransportFuture,
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialDescriptorJSON,
  PublicKeyCredentialRequestOptionsJSON,
  RegistrationResponseJSON,
} from "@simplewebauthn/server";

export interface VirtualPasskeyAuthenticatorConfig {
  rpId: string;
  origin: string;
  userVerified?: boolean;
  aaguid?: Uint8Array;
  transports?: AuthenticatorTransportFuture[];
}

export interface VirtualPasskeyCredentialSummary {
  id: string;
  rpId: string;
  userHandle: string;
  counter: number;
  createdAt: string;
}

export interface VirtualPasskeyRegistrationInput {
  options: PublicKeyCredentialCreationOptionsJSON;
  credentialId?: string;
  userHandle?: string;
}

export interface VirtualPasskeyAuthenticationInput {
  options: PublicKeyCredentialRequestOptionsJSON;
  credentialId?: string;
}

export interface VirtualPasskeyAuthenticator {
  createRegistrationResponse(input: VirtualPasskeyRegistrationInput): RegistrationResponseJSON;
  createAuthenticationResponse(
    input: VirtualPasskeyAuthenticationInput,
  ): AuthenticationResponseJSON;
  listCredentials(): VirtualPasskeyCredentialSummary[];
  getCredential(id: string): VirtualPasskeyCredentialSummary | undefined;
}

interface StoredCredential extends VirtualPasskeyCredentialSummary {
  privateKey: KeyObject;
  publicJwk: JsonWebKey;
  cosePublicKey: Uint8Array;
}

function utf8(input: string): Uint8Array {
  return new TextEncoder().encode(input);
}

function base64urlEncode(input: Uint8Array): string {
  return Buffer.from(input).toString("base64url");
}

function base64urlDecode(input: string): Uint8Array {
  return new Uint8Array(Buffer.from(input, "base64url"));
}

function sha256(input: Uint8Array): Uint8Array {
  return new Uint8Array(createHash("sha256").update(input).digest());
}

function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    merged.set(part, offset);
    offset += part.length;
  }
  return merged;
}

function writeUint16BE(value: number): Uint8Array {
  const buffer = Buffer.alloc(2);
  buffer.writeUInt16BE(value, 0);
  return new Uint8Array(buffer);
}

function writeUint32BE(value: number): Uint8Array {
  const buffer = Buffer.alloc(4);
  buffer.writeUInt32BE(value >>> 0, 0);
  return new Uint8Array(buffer);
}

function randomCredentialId(): string {
  return base64urlEncode(randomBytes(32));
}

function buildClientDataJSON(input: {
  type: "webauthn.create" | "webauthn.get";
  challenge: string;
  origin: string;
}): Uint8Array {
  return utf8(
    JSON.stringify({
      type: input.type,
      challenge: input.challenge,
      origin: input.origin,
      crossOrigin: false,
    }),
  );
}

function buildCosePublicKey(publicJwk: JsonWebKey): Uint8Array {
  if (!publicJwk.x || !publicJwk.y) {
    throw new Error("P-256 public JWK was missing x/y coordinates");
  }

  const cosePublicKey: CBORType = new Map<string | number, CBORType>([
    [1, 2], // kty: EC2
    [3, -7], // alg: ES256
    [-1, 1], // crv: P-256
    [-2, base64urlDecode(publicJwk.x)],
    [-3, base64urlDecode(publicJwk.y)],
  ]);

  return encodeCBOR(cosePublicKey);
}

function buildRegistrationAuthenticatorData(input: {
  rpId: string;
  credentialId: string;
  cosePublicKey: Uint8Array;
  aaguid: Uint8Array;
  userVerified: boolean;
  backedUp: boolean;
}): Uint8Array {
  const rpIdHash = sha256(utf8(input.rpId));
  const flags = new Uint8Array([1 | (input.userVerified ? 1 << 2 : 0) | (1 << 6)]); // UP + UV + AT
  const counter = writeUint32BE(0);
  const credentialId = base64urlDecode(input.credentialId);
  return concatBytes(
    rpIdHash,
    flags,
    counter,
    input.aaguid,
    writeUint16BE(credentialId.length),
    credentialId,
    input.cosePublicKey,
  );
}

function buildAuthenticationAuthenticatorData(input: {
  rpId: string;
  counter: number;
  userVerified: boolean;
  backedUp: boolean;
}): Uint8Array {
  const rpIdHash = sha256(utf8(input.rpId));
  const flags = new Uint8Array([1 | (input.userVerified ? 1 << 2 : 0)]); // UP + UV
  const counter = writeUint32BE(input.counter);
  return concatBytes(rpIdHash, flags, counter);
}

function buildAttestationObject(authData: Uint8Array): Uint8Array {
  const attestationObject: CBORType = new Map<string | number, CBORType>([
    ["fmt", "none"],
    ["attStmt", new Map<string | number, CBORType>()],
    ["authData", authData],
  ]);

  return encodeCBOR(attestationObject);
}

function matchesCredentialDescriptor(
  descriptor: PublicKeyCredentialDescriptorJSON,
  credentialId: string,
): boolean {
  return descriptor.type === "public-key" && descriptor.id === credentialId;
}

function assertSupportedRegistrationOptions(
  options: PublicKeyCredentialCreationOptionsJSON,
  rpId: string,
): void {
  if (!options.rp?.id) {
    throw new Error("Registration options were missing rp.id");
  }
  if (options.rp.id !== rpId) {
    throw new Error(`Registration options RP ID ${options.rp.id} did not match ${rpId}`);
  }
  if (!options.challenge) {
    throw new Error("Registration options were missing a challenge");
  }
  const supportsEs256 = options.pubKeyCredParams.some(
    (param) => param.type === "public-key" && param.alg === -7,
  );
  if (!supportsEs256) {
    throw new Error("Registration options did not include ES256");
  }
}

function assertSupportedAuthenticationOptions(
  options: PublicKeyCredentialRequestOptionsJSON,
  rpId: string,
): void {
  if (options.rpId && options.rpId !== rpId) {
    throw new Error(`Authentication options RP ID ${options.rpId} did not match ${rpId}`);
  }
  if (!options.challenge) {
    throw new Error("Authentication options were missing a challenge");
  }
}

function chooseCredentialId(
  credentials: StoredCredential[],
  options: PublicKeyCredentialRequestOptionsJSON,
  explicitId?: string,
): StoredCredential {
  if (explicitId) {
    const found = credentials.find((credential) => credential.id === explicitId);
    if (!found) {
      throw new Error(`Unknown credential ID ${explicitId}`);
    }
    return found;
  }

  const allowList = options.allowCredentials?.filter((item) => item.type === "public-key") ?? [];
  for (const descriptor of allowList) {
    const found = credentials.find((credential) => credential.id === descriptor.id);
    if (found) {
      return found;
    }
  }

  if (credentials.length === 1) {
    return credentials[0];
  }

  if (credentials.length === 0) {
    throw new Error("No virtual passkey credentials are registered");
  }

  return credentials[credentials.length - 1];
}

function credentialSummary(credential: StoredCredential): VirtualPasskeyCredentialSummary {
  return {
    id: credential.id,
    rpId: credential.rpId,
    userHandle: credential.userHandle,
    counter: credential.counter,
    createdAt: credential.createdAt,
  };
}

export function createVirtualPasskeyAuthenticator(
  config: VirtualPasskeyAuthenticatorConfig,
): VirtualPasskeyAuthenticator {
  const credentials = new Map<string, StoredCredential>();
  const userVerified = config.userVerified ?? true;
  const aaguid = config.aaguid ?? new Uint8Array(16);
  const transports = config.transports ?? ["internal"];

  function storeCredential(input: {
    credentialId: string;
    privateKey: KeyObject;
    publicJwk: JsonWebKey;
    cosePublicKey: Uint8Array;
    userHandle: string;
  }): StoredCredential {
    const summary: StoredCredential = {
      id: input.credentialId,
      rpId: config.rpId,
      userHandle: input.userHandle,
      counter: 0,
      createdAt: new Date().toISOString(),
      privateKey: input.privateKey,
      publicJwk: input.publicJwk,
      cosePublicKey: input.cosePublicKey,
    };
    credentials.set(summary.id, summary);
    return summary;
  }

  function pickNewCredentialId(options: PublicKeyCredentialCreationOptionsJSON): string {
    const excluded = new Set(options.excludeCredentials?.map((item) => item.id) ?? []);
    let credentialId = randomCredentialId();
    while (excluded.has(credentialId) || credentials.has(credentialId)) {
      credentialId = randomCredentialId();
    }
    return credentialId;
  }

  return {
    createRegistrationResponse(input: VirtualPasskeyRegistrationInput): RegistrationResponseJSON {
      assertSupportedRegistrationOptions(input.options, config.rpId);
      const credentialId = input.credentialId ?? pickNewCredentialId(input.options);
      const userHandle = input.userHandle ?? input.options.user.id;
      const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
      const publicJwk = publicKey.export({ format: "jwk" }) as JsonWebKey;
      const cosePublicKey = buildCosePublicKey(publicJwk);
      const stored = storeCredential({
        credentialId,
        privateKey,
        publicJwk,
        cosePublicKey,
        userHandle,
      });

      const clientDataJSON = buildClientDataJSON({
        type: "webauthn.create",
        challenge: input.options.challenge,
        origin: config.origin,
      });
      const authData = buildRegistrationAuthenticatorData({
        rpId: config.rpId,
        credentialId: stored.id,
        cosePublicKey,
        aaguid,
        userVerified,
        backedUp: false,
      });
      const attestationObject = buildAttestationObject(authData);

      return {
        id: stored.id,
        rawId: stored.id,
        type: "public-key",
        response: {
          clientDataJSON: base64urlEncode(clientDataJSON),
          attestationObject: base64urlEncode(attestationObject),
          transports,
          publicKeyAlgorithm: -7,
          publicKey: base64urlEncode(cosePublicKey),
        },
        clientExtensionResults: {},
      };
    },

    createAuthenticationResponse(
      input: VirtualPasskeyAuthenticationInput,
    ): AuthenticationResponseJSON {
      assertSupportedAuthenticationOptions(input.options, config.rpId);
      const available = [...credentials.values()].filter((credential) =>
        input.options.allowCredentials?.length
          ? input.options.allowCredentials.some((item) =>
              matchesCredentialDescriptor(item, credential.id),
            )
          : true,
      );
      const selected = chooseCredentialId(available, input.options, input.credentialId);
      const nextCounter = selected.counter + 1;
      selected.counter = nextCounter;

      const clientDataJSON = buildClientDataJSON({
        type: "webauthn.get",
        challenge: input.options.challenge,
        origin: config.origin,
      });
      const authenticatorData = buildAuthenticationAuthenticatorData({
        rpId: config.rpId,
        counter: nextCounter,
        userVerified,
        backedUp: false,
      });
      const signatureBase = concatBytes(authenticatorData, sha256(clientDataJSON));
      const signature = sign("sha256", signatureBase, selected.privateKey);

      return {
        id: selected.id,
        rawId: selected.id,
        type: "public-key",
        response: {
          clientDataJSON: base64urlEncode(clientDataJSON),
          authenticatorData: base64urlEncode(authenticatorData),
          signature: base64urlEncode(signature),
          userHandle: base64urlEncode(utf8(selected.userHandle)),
        },
        clientExtensionResults: {},
      };
    },

    listCredentials(): VirtualPasskeyCredentialSummary[] {
      return [...credentials.values()]
        .map(credentialSummary)
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    },

    getCredential(id: string): VirtualPasskeyCredentialSummary | undefined {
      const credential = credentials.get(id);
      return credential ? credentialSummary(credential) : undefined;
    },
  };
}
