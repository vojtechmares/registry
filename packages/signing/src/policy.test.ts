import { describe, expect, it } from "vitest";
import { COSIGN_SIGNATURE_ARTIFACT_TYPE, NOTATION_SIGNATURE_ARTIFACT_TYPE } from "./detect.js";
import { type SignedSubject, needsSignatureOnPull, needsSignatureOnPush } from "./policy.js";

const OTHER = `sha256:${"cd".repeat(32)}`;

function subject(overrides: Partial<SignedSubject> = {}): SignedSubject {
  return { artifactType: null, subjectDigest: null, ...overrides };
}

describe("needsSignatureOnPush", () => {
  it("checks an ordinary image being tagged", () => {
    expect(needsSignatureOnPush(subject(), "v1.0.0")).toBe(true);
  });

  it("exempts a push by digest, which is how a manifest becomes signable at all", () => {
    // A signature names the digest it signs, so the digest has to exist first.
    // Demanding one to push by digest states a rule nothing can ever satisfy.
    expect(needsSignatureOnPush(subject(), null)).toBe(false);
  });

  it("exempts a manifest that is itself an attachment", () => {
    expect(needsSignatureOnPush(subject({ subjectDigest: OTHER }), "v1")).toBe(false);
  });

  it("exempts a signature pushed through the referrers API", () => {
    expect(needsSignatureOnPush(subject({ artifactType: COSIGN_SIGNATURE_ARTIFACT_TYPE }), "v1")).toBe(false);
    expect(needsSignatureOnPush(subject({ artifactType: NOTATION_SIGNATURE_ARTIFACT_TYPE }), "v1")).toBe(
      false,
    );
  });

  it("exempts a signature pushed to its legacy cosign tag", () => {
    expect(needsSignatureOnPush(subject(), `sha256-${"cd".repeat(32)}.sig`)).toBe(false);
  });

  it("still checks a manifest tagged with something that merely resembles an attachment", () => {
    expect(needsSignatureOnPush(subject(), "sha256-nothex.sig")).toBe(true);
    expect(needsSignatureOnPush(subject(), `sha256-${"cd".repeat(32)}.evil`)).toBe(true);
  });
});

describe("needsSignatureOnPull", () => {
  it("checks an ordinary image", () => {
    expect(needsSignatureOnPull(subject())).toBe(true);
  });

  it("exempts an attachment, so a verifier can fetch the signature it came for", () => {
    expect(needsSignatureOnPull(subject({ subjectDigest: OTHER }))).toBe(false);
    expect(needsSignatureOnPull(subject({ artifactType: COSIGN_SIGNATURE_ARTIFACT_TYPE }))).toBe(false);
  });
});
