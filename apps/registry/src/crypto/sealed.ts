/**
 * Encrypting a secret the registry has to be able to read back.
 *
 * A replication rule holds the password to somebody else's registry. It cannot
 * be hashed, because the registry has to present it; so it is sealed with
 * AES-GCM under a key derived from a Worker secret, and a database that leaks
 * yields ciphertext.
 *
 * HKDF derives the encryption key rather than using the signing secret
 * directly, so the same secret can key two things without either weakening the
 * other. The `info` string is what keeps them apart.
 */

const INFO = "registry:replication-credentials:v1";

async function derive(secret: string, salt: Uint8Array): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), "HKDF", false, [
    "deriveKey",
  ]);

  return crypto.subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: salt as unknown as BufferSource,
      info: new TextEncoder().encode(INFO),
    },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function fromBase64(text: string): Uint8Array {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/**
 * `v1.<salt>.<iv>.<ciphertext>`, all base64.
 *
 * The salt is per-secret, so two rules holding the same password do not share a
 * key, and the version prefix means a future scheme can be told apart from this
 * one rather than mis-decrypted as it.
 */
export async function seal(plaintext: string, secret: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await derive(secret, salt);

  const sealed = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: iv as unknown as BufferSource },
    key,
    new TextEncoder().encode(plaintext),
  );

  return `v1.${toBase64(salt)}.${toBase64(iv)}.${toBase64(new Uint8Array(sealed))}`;
}

/** Null when the ciphertext was tampered with, truncated, or sealed under another secret. */
export async function unseal(sealed: string, secret: string): Promise<string | null> {
  const parts = sealed.split(".");
  if (parts.length !== 4 || parts[0] !== "v1") return null;

  try {
    const salt = fromBase64(parts[1]!);
    const iv = fromBase64(parts[2]!);
    const ciphertext = fromBase64(parts[3]!);
    const key = await derive(secret, salt);

    const plaintext = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: iv as unknown as BufferSource },
      key,
      ciphertext as unknown as BufferSource,
    );
    return new TextDecoder().decode(plaintext);
  } catch {
    // A failed authentication tag is indistinguishable from malformed input,
    // and neither is worth telling the caller apart.
    return null;
  }
}
