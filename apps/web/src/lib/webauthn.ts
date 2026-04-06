type Base64URLString = string;

export interface PublicKeyCredentialCreationOptionsJSON {
  rp: PublicKeyCredentialRpEntity;
  user: {
    id: Base64URLString;
    name: string;
    displayName: string;
  };
  challenge: Base64URLString;
  pubKeyCredParams: PublicKeyCredentialParameters[];
  timeout?: number;
  excludeCredentials?: Array<{
    id: Base64URLString;
    type: PublicKeyCredentialType;
    transports?: AuthenticatorTransport[];
  }>;
  authenticatorSelection?: AuthenticatorSelectionCriteria;
  attestation?: AttestationConveyancePreference;
  extensions?: AuthenticationExtensionsClientInputs;
}

export interface PublicKeyCredentialRequestOptionsJSON {
  challenge: Base64URLString;
  timeout?: number;
  rpId?: string;
  allowCredentials?: Array<{
    id: Base64URLString;
    type: PublicKeyCredentialType;
    transports?: AuthenticatorTransport[];
  }>;
  userVerification?: UserVerificationRequirement;
  extensions?: AuthenticationExtensionsClientInputs;
}

function padBase64(value: string): string {
  return value + "=".repeat((4 - (value.length % 4)) % 4);
}

export function base64UrlToBuffer(value: string): ArrayBuffer {
  const normalized = padBase64(value.replace(/-/g, "+").replace(/_/g, "/"));
  const binary = atob(normalized);
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  return buffer;
}

export function bufferToBase64Url(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

export function creationOptionsFromJson(
  options: PublicKeyCredentialCreationOptionsJSON,
): PublicKeyCredentialCreationOptions {
  return {
    ...options,
    challenge: base64UrlToBuffer(options.challenge),
    user: {
      ...options.user,
      id: base64UrlToBuffer(options.user.id),
    },
    excludeCredentials: options.excludeCredentials?.map((credential) => ({
      ...credential,
      id: base64UrlToBuffer(credential.id),
    })),
  };
}

export function requestOptionsFromJson(
  options: PublicKeyCredentialRequestOptionsJSON,
): PublicKeyCredentialRequestOptions {
  return {
    ...options,
    challenge: base64UrlToBuffer(options.challenge),
    allowCredentials: options.allowCredentials?.map((credential) => ({
      ...credential,
      id: base64UrlToBuffer(credential.id),
    })),
  };
}

export function serializeRegistrationCredential(
  credential: Credential,
): Record<string, unknown> {
  const publicKeyCredential = credential as PublicKeyCredential;
  const response = publicKeyCredential.response as AuthenticatorAttestationResponse;

  return {
    id: publicKeyCredential.id,
    rawId: bufferToBase64Url(publicKeyCredential.rawId),
    type: publicKeyCredential.type,
    clientExtensionResults: publicKeyCredential.getClientExtensionResults(),
    response: {
      attestationObject: bufferToBase64Url(response.attestationObject),
      clientDataJSON: bufferToBase64Url(response.clientDataJSON),
      transports: typeof response.getTransports === "function" ? response.getTransports() : [],
      publicKeyAlgorithm:
        typeof response.getPublicKeyAlgorithm === "function"
          ? response.getPublicKeyAlgorithm()
          : undefined,
    },
    authenticatorAttachment: publicKeyCredential.authenticatorAttachment ?? undefined,
  };
}

export function serializeAuthenticationCredential(
  credential: Credential,
): Record<string, unknown> {
  const publicKeyCredential = credential as PublicKeyCredential;
  const response = publicKeyCredential.response as AuthenticatorAssertionResponse;

  return {
    id: publicKeyCredential.id,
    rawId: bufferToBase64Url(publicKeyCredential.rawId),
    type: publicKeyCredential.type,
    clientExtensionResults: publicKeyCredential.getClientExtensionResults(),
    response: {
      authenticatorData: bufferToBase64Url(response.authenticatorData),
      clientDataJSON: bufferToBase64Url(response.clientDataJSON),
      signature: bufferToBase64Url(response.signature),
      userHandle: response.userHandle ? bufferToBase64Url(response.userHandle) : null,
    },
    authenticatorAttachment: publicKeyCredential.authenticatorAttachment ?? undefined,
  };
}
