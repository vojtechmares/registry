import { beforeEach, describe, expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";
import type { ManifestDetail } from "@registry/api-contract";
import { Manifest } from "./manifest";
import { renderWithProviders } from "@/test/render";

const mocks = vi.hoisted(() => ({ manifest: vi.fn() }));

vi.mock("@/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api")>()),
  api: mocks,
}));

const DIGEST = `sha256:${"a".repeat(64)}`;

const manifest: ManifestDetail = {
  digest: DIGEST,
  mediaType: "application/vnd.oci.image.manifest.v1+json",
  artifactType: null,
  size: 100,
  subjectDigest: null,
  annotations: null,
  createdAt: Date.now(),
  tags: ["v1"],
  blobs: [],
  referrers: [],
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.manifest.mockResolvedValue(manifest);
});

describe("Manifest", () => {
  it("renders the manifest it loaded", async () => {
    renderWithProviders(<Manifest repo="acme/api" digest={DIGEST} />);
    expect(await screen.findByRole("heading", { name: DIGEST })).toBeInTheDocument();
    expect(screen.getByText("application/vnd.oci.image.manifest.v1+json")).toBeInTheDocument();
  });

  it("reports an error when the manifest cannot be loaded", async () => {
    mocks.manifest.mockRejectedValue(new Error("boom"));
    renderWithProviders(<Manifest repo="acme/api" digest={DIGEST} />);
    expect(await screen.findByText("Could not load that manifest.")).toBeInTheDocument();
  });
});
