import {
  constantTimeEqual,
  createOpaqueToken,
  fingerprint,
} from "../auth/crypto.js";

const apiKeyNamespace = "opensession.public-api-key.v1";
const apiKeyPattern =
  /^(osk_(key_[A-Za-z0-9_-]{20,80}))\.([A-Za-z0-9_-]{32,100})$/;

export interface ApiKeyMaterial {
  readonly id: string;
  readonly plaintext: string;
  readonly prefix: string;
  readonly salt: string;
  readonly verifier: string;
}

export interface ParsedApiKey {
  readonly id: string;
  readonly plaintext: string;
  readonly prefix: string;
}

function randomHex(byteLength: number): string {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
}

export async function apiKeyVerifier(
  plaintext: string,
  salt: string,
  pepper: string,
): Promise<string> {
  return fingerprint(`${salt}\u0000${plaintext}`, pepper, apiKeyNamespace);
}

export async function createApiKeyMaterial(
  pepper: string,
): Promise<ApiKeyMaterial> {
  const id = `key_${createOpaqueToken(18)}`;
  const prefix = `osk_${id}`;
  const plaintext = `${prefix}.${createOpaqueToken(32)}`;
  const salt = randomHex(16);
  return {
    id,
    plaintext,
    prefix,
    salt,
    verifier: await apiKeyVerifier(plaintext, salt, pepper),
  };
}

export function parseApiKey(value: string): ParsedApiKey | null {
  const match = apiKeyPattern.exec(value);
  if (!match?.[1] || !match[2]) return null;
  return { id: match[2], plaintext: value, prefix: match[1] };
}

export async function verifyApiKeyVerifier(
  plaintext: string,
  salt: string,
  pepper: string,
  expectedVerifier: string,
): Promise<boolean> {
  const candidate = await apiKeyVerifier(plaintext, salt, pepper);
  return constantTimeEqual(candidate, expectedVerifier);
}
