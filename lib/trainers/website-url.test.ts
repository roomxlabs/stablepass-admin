import { describe, it, expect } from "vitest";
import { parseWebsiteUrl, WEBSITE_URL_MESSAGE } from "./website-url";

describe("parseWebsiteUrl", () => {
  it("treats null as no website", () => {
    expect(parseWebsiteUrl(null)).toEqual({ ok: true, value: null });
  });

  it("treats undefined as no website", () => {
    expect(parseWebsiteUrl(undefined)).toEqual({ ok: true, value: null });
  });

  it("treats an empty string as no website", () => {
    expect(parseWebsiteUrl("")).toEqual({ ok: true, value: null });
  });

  it("treats a whitespace-only string as no website", () => {
    expect(parseWebsiteUrl("   ")).toEqual({ ok: true, value: null });
  });

  it("rejects a number", () => {
    const r = parseWebsiteUrl(42);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toBe(WEBSITE_URL_MESSAGE);
  });

  it("rejects an object", () => {
    const r = parseWebsiteUrl({});
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toBe(WEBSITE_URL_MESSAGE);
  });

  it("accepts an https URL", () => {
    expect(parseWebsiteUrl("https://x.com")).toEqual({ ok: true, value: "https://x.com" });
  });

  it("accepts an http URL", () => {
    expect(parseWebsiteUrl("http://x.com")).toEqual({ ok: true, value: "http://x.com" });
  });

  it("trims surrounding whitespace", () => {
    expect(parseWebsiteUrl("  https://x.com  ")).toEqual({ ok: true, value: "https://x.com" });
  });

  it("rejects a javascript: url", () => {
    const r = parseWebsiteUrl("javascript:alert(1)");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toBe(WEBSITE_URL_MESSAGE);
  });

  it("rejects a data: url", () => {
    const r = parseWebsiteUrl("data:text/html,x");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toBe(WEBSITE_URL_MESSAGE);
  });

  it("rejects a file: url", () => {
    const r = parseWebsiteUrl("file:///etc/passwd");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toBe(WEBSITE_URL_MESSAGE);
  });

  it("rejects a bare domain with no protocol", () => {
    const r = parseWebsiteUrl("wallerracing.com.au");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toBe(WEBSITE_URL_MESSAGE);
  });

  it("rejects a protocol-relative url", () => {
    const r = parseWebsiteUrl("//example.com");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toBe(WEBSITE_URL_MESSAGE);
  });

  it("returns the trimmed original, never url.href (no trailing-slash normalisation)", () => {
    const r = parseWebsiteUrl("https://x.com");
    expect(r).toEqual({ ok: true, value: "https://x.com" });
    if (r.ok) expect(r.value).not.toBe("https://x.com/");
  });
});
