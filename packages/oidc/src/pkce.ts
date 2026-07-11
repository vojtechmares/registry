/**
 * Proof Key for Code Exchange, and the two other one-time values an
 * authorization-code flow needs.
 *
 * `state` binds the callback to the browser that started the flow, and stops a
 * third party from feeding this registry a code of their own. `nonce` binds the
 * ID token to the same flow, and stops one obtained elsewhere from being
 * replayed here. `code_verifier` binds the code to whoever asked for it, so a
 * code intercepted in a redirect cannot be exchanged by anyone else.
 *
 * All three are useless if any of them is skipped, and skipping one is easy,
 * which is why they are minted together - now by `oauth4webapi`, whose random
 * values and S256 challenge are the audited counterparts of the ones this file
 * used to compute by hand.
 */

import {
  calculatePKCECodeChallenge,
  generateRandomCodeVerifier,
  generateRandomNonce,
  generateRandomState,
} from "oauth4webapi";

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export interface AuthorizationRequest {
  readonly state: string;
  readonly nonce: string;
  readonly codeVerifier: string;
  readonly codeChallenge: string;
}

/** `S256`, never `plain`: a plain challenge is the verifier, and protects nothing. */
export function codeChallengeOf(verifier: string): Promise<string> {
  return calculatePKCECodeChallenge(verifier);
}

export async function createAuthorizationRequest(): Promise<AuthorizationRequest> {
  const codeVerifier = generateRandomCodeVerifier();
  return {
    state: generateRandomState(),
    nonce: generateRandomNonce(),
    codeVerifier,
    codeChallenge: await codeChallengeOf(codeVerifier),
  };
}

/** Constant time, because it compares a secret the caller supplied against one we minted. */
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let difference = 0;
  for (let i = 0; i < a.length; i++) difference |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return difference === 0;
}

export { base64UrlEncode };
