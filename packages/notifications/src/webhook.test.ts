import { describe, expect, it } from "vitest";
import { isAllowedWebhookUrl, signPayload, verifySignature } from "./webhook.js";

const SECRET = "shhh";

describe("signPayload", () => {
  it("produces a stable `sha256=<hex>` signature", async () => {
    const signature = await signPayload('{"a":1}', SECRET);
    expect(signature).toMatch(/^sha256=[a-f0-9]{64}$/);
    expect(await signPayload('{"a":1}', SECRET)).toBe(signature);
  });

  it("changes with the body and with the secret", async () => {
    const base = await signPayload('{"a":1}', SECRET);
    expect(await signPayload('{"a":2}', SECRET)).not.toBe(base);
    expect(await signPayload('{"a":1}', "other")).not.toBe(base);
  });
});

describe("verifySignature", () => {
  it("accepts the signature it produced", async () => {
    const body = '{"hello":"world"}';
    expect(await verifySignature(body, await signPayload(body, SECRET), SECRET)).toBe(true);
  });

  it("rejects a tampered body, a wrong secret, and a malformed signature", async () => {
    const body = '{"hello":"world"}';
    const signature = await signPayload(body, SECRET);

    expect(await verifySignature('{"hello":"there"}', signature, SECRET)).toBe(false);
    expect(await verifySignature(body, signature, "wrong")).toBe(false);
    expect(await verifySignature(body, "garbage", SECRET)).toBe(false);
    expect(await verifySignature(body, "sha256=short", SECRET)).toBe(false);
    expect(await verifySignature(body, "", SECRET)).toBe(false);
  });
});

describe("isAllowedWebhookUrl", () => {
  it("accepts an ordinary https endpoint", () => {
    expect(isAllowedWebhookUrl("https://example.com/hook")).toBe(true);
    expect(isAllowedWebhookUrl("https://hooks.slack.com/services/x/y/z")).toBe(true);
  });

  it("refuses plain http, which would put the signature and the payload on the wire", () => {
    expect(isAllowedWebhookUrl("http://example.com/hook")).toBe(false);
  });

  it("refuses anything that is not http at all", () => {
    expect(isAllowedWebhookUrl("file:///etc/passwd")).toBe(false);
    expect(isAllowedWebhookUrl("gopher://example.com")).toBe(false);
    expect(isAllowedWebhookUrl("data:text/plain,hi")).toBe(false);
  });

  it("refuses loopback and link-local addresses", () => {
    // A project owner chooses this URL. It must not become a way to make the
    // registry fetch something only the registry can reach.
    expect(isAllowedWebhookUrl("https://127.0.0.1/hook")).toBe(false);
    expect(isAllowedWebhookUrl("https://localhost/hook")).toBe(false);
    expect(isAllowedWebhookUrl("https://[::1]/hook")).toBe(false);
    expect(isAllowedWebhookUrl("https://169.254.169.254/latest/meta-data")).toBe(false);
  });

  it("refuses every IPv6 literal, however it spells an address", () => {
    // `::ffff:127.0.0.1` is loopback wearing a hat, and `URL` normalises it to
    // `[::ffff:7f00:1]` before any filter gets to look. The compatible form,
    // NAT64, 6to4 and Teredo all do the same trick with different prefixes.
    expect(isAllowedWebhookUrl("https://[::ffff:127.0.0.1]/hook")).toBe(false);
    expect(isAllowedWebhookUrl("https://[::ffff:10.0.0.1]/hook")).toBe(false);
    expect(isAllowedWebhookUrl("https://[::ffff:169.254.169.254]/hook")).toBe(false);
    expect(isAllowedWebhookUrl("https://[0:0:0:0:0:ffff:7f00:1]/hook")).toBe(false);
    expect(isAllowedWebhookUrl("https://[64:ff9b::7f00:1]/hook")).toBe(false);
    expect(isAllowedWebhookUrl("https://[::]/hook")).toBe(false);
    expect(isAllowedWebhookUrl("https://[fd00::1]/hook")).toBe(false);
    // And a perfectly ordinary public one, which a receiver would never use.
    expect(isAllowedWebhookUrl("https://[2606:4700::1]/hook")).toBe(false);
  });

  it("refuses private address ranges", () => {
    expect(isAllowedWebhookUrl("https://10.0.0.5/hook")).toBe(false);
    expect(isAllowedWebhookUrl("https://192.168.1.1/hook")).toBe(false);
    expect(isAllowedWebhookUrl("https://172.16.0.1/hook")).toBe(false);
    expect(isAllowedWebhookUrl("https://172.31.255.255/hook")).toBe(false);
  });

  it("does not mistake a public address for a private one", () => {
    expect(isAllowedWebhookUrl("https://172.32.0.1/hook")).toBe(true);
    expect(isAllowedWebhookUrl("https://172.15.0.1/hook")).toBe(true);
    expect(isAllowedWebhookUrl("https://11.0.0.1/hook")).toBe(true);
  });

  it("refuses an internal hostname", () => {
    expect(isAllowedWebhookUrl("https://foo.localhost/hook")).toBe(false);
    expect(isAllowedWebhookUrl("https://service.internal/hook")).toBe(false);
  });

  it("refuses a URL that will not parse", () => {
    expect(isAllowedWebhookUrl("not a url")).toBe(false);
    expect(isAllowedWebhookUrl("")).toBe(false);
  });
});
