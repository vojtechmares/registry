/**
 * Signed webhook delivery.
 *
 * The signature is the only thing that tells a recipient the payload came from
 * this registry rather than from anyone who guessed the URL, so it is over the
 * exact bytes sent and it is compared in constant time.
 */

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
}

function toHex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** `sha256=<hex>`, over the exact body that will be sent. */
export async function signPayload(body: string, secret: string): Promise<string> {
  const signature = await crypto.subtle.sign("HMAC", await hmacKey(secret), new TextEncoder().encode(body));
  return `sha256=${toHex(new Uint8Array(signature))}`;
}

/** Constant time in the length of the digest, which is fixed. */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let difference = 0;
  for (let i = 0; i < a.length; i++) difference |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return difference === 0;
}

export async function verifySignature(body: string, signature: string, secret: string): Promise<boolean> {
  const expected = await signPayload(body, secret);
  return timingSafeEqual(signature, expected);
}

const HEADERS = {
  event: "X-Registry-Event",
  delivery: "X-Registry-Delivery",
  signature: "X-Registry-Signature",
} as const;

export { HEADERS as WEBHOOK_HEADERS };

const BLOCKED_HOSTNAMES = new Set(["localhost", "0.0.0.0", "[::]", "[::1]", "::1"]);
const BLOCKED_SUFFIXES = [".localhost", ".internal", ".local"];

/** Dotted-quad, or null when the hostname is not a literal IPv4 address. */
function parseIPv4(hostname: string): number[] | null {
  const parts = hostname.split(".");
  if (parts.length !== 4) return null;

  const octets: number[] = [];
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const octet = Number(part);
    if (octet > 255) return null;
    octets.push(octet);
  }
  return octets;
}

function isPrivateIPv4(octets: number[]): boolean {
  const [a, b] = octets as [number, number, number, number];
  if (a === 10) return true;
  if (a === 127) return true;
  if (a === 0) return true;
  if (a === 169 && b === 254) return true; // link-local, and cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  return false;
}

/**
 * Whether the registry will call this URL.
 *
 * A project owner chooses it, so it is a request the registry makes on a
 * stranger's behalf, from inside the network. `https` only, because the payload
 * and its signature would otherwise travel in the clear; and never an address
 * that only the registry can reach, because a webhook must not become a way to
 * ask the registry what it can see.
 *
 * This is a filter on the *name*, not on where it resolves. A hostname whose
 * DNS answer is private slips through, and nothing here can prevent that from a
 * Worker. It raises the cost rather than closing the door.
 */
export function isPublicHttpsUrl(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }

  if (url.protocol !== "https:") return false;

  const hostname = url.hostname.toLowerCase();
  if (hostname === "" || BLOCKED_HOSTNAMES.has(hostname)) return false;
  if (BLOCKED_SUFFIXES.some((suffix) => hostname.endsWith(suffix))) return false;

  // `URL` keeps the brackets on an IPv6 literal, and every one of them is
  // refused. IPv6 has too many ways to spell an IPv4 address for a filter to
  // enumerate: `::ffff:127.0.0.1` normalises to `::ffff:7f00:1`, and beside it
  // sit the IPv4-compatible form, NAT64, 6to4 and Teredo, each of which reaches
  // loopback through a prefix that looks like nothing in particular. A receiver
  // on the public internet is named by DNS, never by an IPv6 literal, so
  // refusing the lot costs nothing and closes all of them at once.
  if (hostname.startsWith("[")) return false;

  const octets = parseIPv4(hostname);
  if (octets !== null) return !isPrivateIPv4(octets);

  return true;
}

/**
 * Whether the registry will call this URL on a user's behalf.
 *
 * The same guard for a webhook and for a replication remote: both are
 * server-side fetches to an address the caller chose, and both must be kept off
 * the internal network. `isPublicHttpsUrl` is the same function under its
 * webhook-flavoured name.
 */
export const isAllowedWebhookUrl = isPublicHttpsUrl;
