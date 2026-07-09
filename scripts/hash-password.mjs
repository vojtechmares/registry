#!/usr/bin/env node
/**
 * Produces the `BOOTSTRAP_ADMIN_PASSWORD_HASH` secret.
 *
 * Mirrors apps/registry/src/auth/password.ts exactly. Hashing here rather than
 * in the Worker means the plaintext password never leaves the machine that
 * chose it.
 *
 *   node scripts/hash-password.mjs 'correct horse battery staple'
 */

import { webcrypto } from "node:crypto";

const ITERATIONS = 210_000;
const SALT_BYTES = 16;
const HASH_BITS = 256;

const password = process.argv[2];
if (typeof password !== "string" || password.length === 0) {
  console.error("usage: node scripts/hash-password.mjs <password>");
  process.exit(1);
}

const salt = webcrypto.getRandomValues(new Uint8Array(SALT_BYTES));
const key = await webcrypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, [
  "deriveBits",
]);
const bits = await webcrypto.subtle.deriveBits(
  { name: "PBKDF2", hash: "SHA-256", salt, iterations: ITERATIONS },
  key,
  HASH_BITS,
);

const base64 = (bytes) => Buffer.from(bytes).toString("base64");
console.log(`pbkdf2$${ITERATIONS}$${base64(salt)}$${base64(new Uint8Array(bits))}`);
