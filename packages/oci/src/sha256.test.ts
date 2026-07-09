import { describe, expect, it } from "vitest";
import { SHA256_STATE_SIZE, Sha256, bytesToHex, hexToBytes, sha256Hex } from "./sha256.js";

const utf8 = (text: string) => new TextEncoder().encode(text);

/** Cross-checks our implementation against the platform's, which we trust. */
async function webCrypto(data: Uint8Array): Promise<string> {
  return bytesToHex(new Uint8Array(await crypto.subtle.digest("SHA-256", data as BufferSource)));
}

describe("Sha256", () => {
  it("matches the FIPS 180-4 test vectors", () => {
    expect(sha256Hex(new Uint8Array(0))).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
    expect(sha256Hex(utf8("abc"))).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    expect(sha256Hex(utf8("abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq"))).toBe(
      "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1",
    );
  });

  it("matches the empty-JSON digest the image spec pins", () => {
    expect(sha256Hex(utf8("{}"))).toBe("44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a");
  });

  it("agrees with Web Crypto across the block-boundary sizes", async () => {
    // 55/56/57 and 63/64/65 straddle the padding and block boundaries, where
    // the length field spills into an extra block.
    for (const size of [0, 1, 54, 55, 56, 57, 63, 64, 65, 119, 120, 128, 1000, 4096]) {
      const data = new Uint8Array(size);
      for (let i = 0; i < size; i++) data[i] = (i * 31 + 7) & 0xff;
      expect(sha256Hex(data), `size ${size}`).toBe(await webCrypto(data));
    }
  });

  it("produces the same digest regardless of how input is chunked", async () => {
    const data = new Uint8Array(5000);
    for (let i = 0; i < data.length; i++) data[i] = (i * 17) & 0xff;
    const expected = await webCrypto(data);

    for (const chunkSize of [1, 7, 63, 64, 65, 1024, 5000]) {
      const hash = new Sha256();
      for (let offset = 0; offset < data.length; offset += chunkSize) {
        hash.update(data.subarray(offset, Math.min(offset + chunkSize, data.length)));
      }
      expect(hash.digestHex(), `chunk size ${chunkSize}`).toBe(expected);
    }
  });

  it("survives a serialize/deserialize round trip mid-stream", async () => {
    const data = new Uint8Array(3000);
    for (let i = 0; i < data.length; i++) data[i] = (i * 13 + 3) & 0xff;
    const expected = await webCrypto(data);

    // Suspend and resume at every offset that leaves a partial block pending.
    for (const split of [0, 1, 63, 64, 65, 100, 1500, 2999, 3000]) {
      const first = new Sha256().update(data.subarray(0, split));
      const state = first.serialize();
      expect(state.length).toBe(SHA256_STATE_SIZE);

      const resumed = Sha256.deserialize(state);
      resumed.update(data.subarray(split));
      expect(resumed.digestHex(), `split at ${split}`).toBe(expected);
      expect(resumed.length).toBe(data.length);
    }
  });

  it("leaves the hash usable after digest(), so a final chunk can still arrive", () => {
    const hash = new Sha256().update(utf8("abc"));
    expect(hash.digestHex()).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    // Digesting must not consume the state.
    expect(hash.digestHex()).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    hash.update(utf8("d"));
    expect(hash.digestHex()).toBe(sha256Hex(utf8("abcd")));
  });

  it("tracks length across resumption", () => {
    const hash = new Sha256().update(new Uint8Array(100));
    expect(hash.length).toBe(100);
    expect(Sha256.deserialize(hash.serialize()).length).toBe(100);
  });

  it("rejects corrupt state", () => {
    expect(() => Sha256.deserialize(new Uint8Array(10))).toThrow(/108 bytes/);
    const state = new Sha256().update(utf8("abc")).serialize();
    state[32 + 64 + 3] = 64; // blockLength == BLOCK_SIZE is never valid.
    expect(() => Sha256.deserialize(state)).toThrow(/block overflow/);
  });
});

describe("hex helpers", () => {
  it("round trips", () => {
    const bytes = new Uint8Array([0x00, 0x0f, 0xff, 0xa5]);
    expect(bytesToHex(bytes)).toBe("000fffa5");
    expect(hexToBytes("000fffa5")).toEqual(bytes);
  });

  it("rejects malformed input", () => {
    expect(() => hexToBytes("abc")).toThrow(/even length/);
    expect(() => hexToBytes("zz")).toThrow(/invalid hex/);
  });
});
