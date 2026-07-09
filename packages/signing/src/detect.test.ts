import { describe, expect, it } from "vitest";
import {
  COSIGN_SIGNATURE_ARTIFACT_TYPE,
  NOTATION_SIGNATURE_ARTIFACT_TYPE,
  cosignSignatureTag,
  isAttachmentTag,
  isSignatureArtifactType,
} from "./detect.js";

const DIGEST = `sha256:${"ab".repeat(32)}`;

describe("isSignatureArtifactType", () => {
  it("recognises a cosign signature pushed through the referrers API", () => {
    expect(isSignatureArtifactType(COSIGN_SIGNATURE_ARTIFACT_TYPE)).toBe(true);
  });

  it("recognises a notation signature", () => {
    expect(isSignatureArtifactType(NOTATION_SIGNATURE_ARTIFACT_TYPE)).toBe(true);
  });

  it("does not mistake an SBOM or an attestation for a signature", () => {
    expect(isSignatureArtifactType("application/vnd.dev.cosign.artifact.sbom.v1+json")).toBe(false);
    expect(isSignatureArtifactType("application/vnd.in-toto+json")).toBe(false);
  });

  it("does not mistake an ordinary image config for a signature", () => {
    expect(isSignatureArtifactType("application/vnd.oci.image.config.v1+json")).toBe(false);
    expect(isSignatureArtifactType(null)).toBe(false);
    expect(isSignatureArtifactType(undefined)).toBe(false);
  });
});

describe("cosignSignatureTag", () => {
  it("is the digest with its separator flattened and `.sig` appended", () => {
    expect(cosignSignatureTag(DIGEST)).toBe(`sha256-${"ab".repeat(32)}.sig`);
  });

  it("refuses a reference that is not a digest", () => {
    expect(cosignSignatureTag("latest")).toBeNull();
    expect(cosignSignatureTag("sha256:short")).toBeNull();
  });

  it("produces a tag the distribution spec accepts", () => {
    // 7 + 64 + 4 = 75 characters, and every one of them is legal in a tag.
    const tag = cosignSignatureTag(DIGEST)!;
    expect(tag).toMatch(/^[a-zA-Z0-9_][a-zA-Z0-9._-]{0,127}$/);
  });
});

describe("isAttachmentTag", () => {
  it("recognises every cosign attachment suffix", () => {
    for (const suffix of ["sig", "att", "sbom"]) {
      expect(isAttachmentTag(`sha256-${"ab".repeat(32)}.${suffix}`)).toBe(true);
    }
  });

  it("recognises the referrers fallback tag, which carries no suffix", () => {
    expect(isAttachmentTag(`sha256-${"ab".repeat(32)}`)).toBe(true);
  });

  it("rejects an ordinary tag, however suggestive", () => {
    expect(isAttachmentTag("latest")).toBe(false);
    expect(isAttachmentTag("v1.2.3")).toBe(false);
    expect(isAttachmentTag("release.sig")).toBe(false);
    expect(isAttachmentTag("sha256-nothex.sig")).toBe(false);
  });

  it("rejects a hex string of the wrong length", () => {
    expect(isAttachmentTag(`sha256-${"ab".repeat(31)}.sig`)).toBe(false);
  });

  it("rejects an unknown suffix, which a caller could otherwise choose freely", () => {
    // Were this admitted, pushing `sha256-<hex>.anything` would exempt an
    // unsigned manifest from a project that demands signatures.
    expect(isAttachmentTag(`sha256-${"ab".repeat(32)}.evil`)).toBe(false);
  });
});
