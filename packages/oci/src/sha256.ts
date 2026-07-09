/**
 * SHA-256 with a serializable mid-state.
 *
 * The Web Crypto API only exposes one-shot digests, but a registry has to hash
 * a blob whose bytes arrive across several independent HTTP requests (a chunked
 * upload). Carrying the hash forward requires access to the compression
 * function's intermediate state, so we implement the primitive ourselves and
 * expose {@link Sha256.serialize} / {@link Sha256.deserialize}.
 *
 * Reference: FIPS 180-4, section 6.2.
 */

const K = /* @__PURE__ */ new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98,
  0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
  0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8,
  0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819,
  0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
  0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7,
  0xc67178f2,
]);

const INITIAL_STATE = /* @__PURE__ */ new Uint32Array([
  0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
]);

const BLOCK_SIZE = 64;

/** Byte length of {@link Sha256.serialize} output. */
export const SHA256_STATE_SIZE = 32 + BLOCK_SIZE + 4 + 8;

const HEX = /* @__PURE__ */ Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(2, "0"));

export function bytesToHex(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i++) out += HEX[bytes[i]!];
  return out;
}

export function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) throw new Error("hex string must have an even length");
  // parseInt("0z", 16) yields 0 rather than NaN, so validate the alphabet up front.
  if (!/^[0-9a-fA-F]*$/.test(hex)) throw new Error(`invalid hex string: ${hex}`);
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

export class Sha256 {
  private readonly h = new Uint32Array(INITIAL_STATE);
  private readonly block = new Uint8Array(BLOCK_SIZE);
  /** Scratch message schedule, reused across every compression to avoid churn. */
  private readonly w = new Uint32Array(64);
  private blockLength = 0;
  /** Total bytes consumed. Exact up to 2^53, far beyond any blob we accept. */
  private totalLength = 0;

  get length(): number {
    return this.totalLength;
  }

  update(data: Uint8Array): this {
    this.totalLength += data.length;
    let offset = 0;

    // Top up a partially filled block first.
    if (this.blockLength > 0) {
      const needed = BLOCK_SIZE - this.blockLength;
      const take = Math.min(needed, data.length);
      this.block.set(data.subarray(0, take), this.blockLength);
      this.blockLength += take;
      offset = take;
      if (this.blockLength < BLOCK_SIZE) return this;
      this.compress(this.block, 0);
      this.blockLength = 0;
    }

    // Compress whole blocks straight out of the input, no copying.
    while (offset + BLOCK_SIZE <= data.length) {
      this.compress(data, offset);
      offset += BLOCK_SIZE;
    }

    // Stash the tail.
    if (offset < data.length) {
      this.block.set(data.subarray(offset));
      this.blockLength = data.length - offset;
    }
    return this;
  }

  /** Returns the digest without consuming this instance, so hashing can continue. */
  digest(): Uint8Array {
    const clone = this.clone();
    return clone.finalize();
  }

  digestHex(): string {
    return bytesToHex(this.digest());
  }

  clone(): Sha256 {
    const copy = new Sha256();
    copy.h.set(this.h);
    copy.block.set(this.block);
    copy.blockLength = this.blockLength;
    copy.totalLength = this.totalLength;
    return copy;
  }

  /**
   * Snapshot the mid-state so hashing can resume in a later request. The layout
   * is: 8 state words, the pending block, its length, then the total bit-less
   * byte count — all big-endian.
   */
  serialize(): Uint8Array {
    const out = new Uint8Array(SHA256_STATE_SIZE);
    const view = new DataView(out.buffer);
    for (let i = 0; i < 8; i++) view.setUint32(i * 4, this.h[i]!, false);
    out.set(this.block, 32);
    view.setUint32(32 + BLOCK_SIZE, this.blockLength, false);
    // totalLength is < 2^53, so it splits cleanly into two 32-bit halves.
    view.setUint32(36 + BLOCK_SIZE, Math.floor(this.totalLength / 0x100000000), false);
    view.setUint32(40 + BLOCK_SIZE, this.totalLength >>> 0, false);
    return out;
  }

  static deserialize(state: Uint8Array): Sha256 {
    if (state.length !== SHA256_STATE_SIZE) {
      throw new Error(`sha256 state must be ${SHA256_STATE_SIZE} bytes, got ${state.length}`);
    }
    const hash = new Sha256();
    const view = new DataView(state.buffer, state.byteOffset, state.byteLength);
    for (let i = 0; i < 8; i++) hash.h[i] = view.getUint32(i * 4, false);
    hash.block.set(state.subarray(32, 32 + BLOCK_SIZE));
    hash.blockLength = view.getUint32(32 + BLOCK_SIZE, false);
    if (hash.blockLength >= BLOCK_SIZE) throw new Error("corrupt sha256 state: block overflow");
    const high = view.getUint32(36 + BLOCK_SIZE, false);
    const low = view.getUint32(40 + BLOCK_SIZE, false);
    hash.totalLength = high * 0x100000000 + low;
    return hash;
  }

  /** Applies the FIPS 180-4 padding and emits the big-endian digest. */
  private finalize(): Uint8Array {
    const bitLength = this.totalLength * 8;
    this.block[this.blockLength++] = 0x80;

    // The length field needs the last 8 bytes; spill into another block if it does not fit.
    if (this.blockLength > BLOCK_SIZE - 8) {
      this.block.fill(0, this.blockLength);
      this.compress(this.block, 0);
      this.blockLength = 0;
    }
    this.block.fill(0, this.blockLength);

    const view = new DataView(this.block.buffer);
    view.setUint32(BLOCK_SIZE - 8, Math.floor(bitLength / 0x100000000), false);
    view.setUint32(BLOCK_SIZE - 4, bitLength >>> 0, false);
    this.compress(this.block, 0);

    const out = new Uint8Array(32);
    const outView = new DataView(out.buffer);
    for (let i = 0; i < 8; i++) outView.setUint32(i * 4, this.h[i]!, false);
    return out;
  }

  private compress(data: Uint8Array, offset: number): void {
    const w = this.w;

    for (let i = 0; i < 16; i++) {
      const o = offset + i * 4;
      w[i] = (data[o]! << 24) | (data[o + 1]! << 16) | (data[o + 2]! << 8) | data[o + 3]!;
    }
    for (let i = 16; i < 64; i++) {
      const x = w[i - 15]!;
      const y = w[i - 2]!;
      const s0 = ((x >>> 7) | (x << 25)) ^ ((x >>> 18) | (x << 14)) ^ (x >>> 3);
      const s1 = ((y >>> 17) | (y << 15)) ^ ((y >>> 19) | (y << 13)) ^ (y >>> 10);
      w[i] = (w[i - 16]! + s0 + w[i - 7]! + s1) | 0;
    }

    let a = this.h[0]!;
    let b = this.h[1]!;
    let c = this.h[2]!;
    let d = this.h[3]!;
    let e = this.h[4]!;
    let f = this.h[5]!;
    let g = this.h[6]!;
    let h = this.h[7]!;

    for (let i = 0; i < 64; i++) {
      const S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
      const ch = (e & f) ^ (~e & g);
      const temp1 = (h + S1 + ch + K[i]! + w[i]!) | 0;
      const S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (S0 + maj) | 0;

      h = g;
      g = f;
      f = e;
      e = (d + temp1) | 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) | 0;
    }

    this.h[0] = (this.h[0]! + a) | 0;
    this.h[1] = (this.h[1]! + b) | 0;
    this.h[2] = (this.h[2]! + c) | 0;
    this.h[3] = (this.h[3]! + d) | 0;
    this.h[4] = (this.h[4]! + e) | 0;
    this.h[5] = (this.h[5]! + f) | 0;
    this.h[6] = (this.h[6]! + g) | 0;
    this.h[7] = (this.h[7]! + h) | 0;
  }
}

export function sha256Hex(data: Uint8Array): string {
  return new Sha256().update(data).digestHex();
}
