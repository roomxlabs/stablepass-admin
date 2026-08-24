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

// The protocol check in website-url.ts is an ALLOW-LIST (accept only http/https).
// Table-driven rather than one-off cases on purpose: an inverted condition -
// e.g. rewriting the check into a BLOCK-LIST of "javascript:" / "data:" /
// "file:" - passes every test above that only tries those three schemes,
// silently letting everything else (ftp:, mailto:, tel:, vbscript:, blob:,
// ws:, wss:, chrome:, about:, intent:) through as a "saveable" website. Any
// such value renders as NO LINK in stablepass-web - an invisible saved
// website. Enumerating a broad set of non-http(s) schemes here is what
// actually pins the allow-list shape, not just the three schemes someone
// happened to think of first.
describe("parseWebsiteUrl — protocol allow-list (table-driven)", () => {
  it.each([
    "javascript:alert(1)",
    "data:text/html,x",
    "file:///etc/passwd",
    "mailto:a@b.com",
    "ftp://x.com/f",
    "tel:+61400000000",
    "vbscript:msgbox(1)",
    "blob:https://x.com/uuid",
    "ws://x.com",
    "wss://x.com",
    "chrome://settings",
    "about:blank",
    "intent://x",
  ])("rejects %j (not http/https)", (value) => {
    const r = parseWebsiteUrl(value);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toBe(WEBSITE_URL_MESSAGE);
  });

  it.each(["http://x.com", "https://x.com", "https://wallerracing.com.au"])(
    "accepts %j",
    (value) => {
      const r = parseWebsiteUrl(value);
      expect(r).toEqual({ ok: true, value });
    },
  );
});


// Obfuscated schemes and control characters. These already fail today; pinning
// them matters because they are exactly what a future "simplification" of the
// check (say, to `trimmed.startsWith("http")`) would quietly let through, and
// because the WHATWG parser strips tabs/newlines/leading-C0 BEFORE deciding the
// protocol - so the scheme a human reads is not always the scheme that results.
describe("parseWebsiteUrl - obfuscated schemes and control characters", () => {
  it.each([
    ["mixed case javascript", "JaVaScRiPt:alert(1)"],
    ["uppercase javascript", "JAVASCRIPT:alert(1)"],
    ["tab inside the scheme", "java\tscript:alert(1)"],
    ["newline inside the scheme", "java\nscript:alert(1)"],
    ["carriage return inside the scheme", "java\rscript:alert(1)"],
    ["tab before the colon", "javascript\t:alert(1)"],
    ["leading NUL", "\u0000javascript:alert(1)"],
    ["leading SOH", "\u0001javascript:alert(1)"],
    ["leading unit separator", "\u001fjavascript:alert(1)"],
    ["mixed case vbscript", "VbScRiPt:msgbox(1)"],
  ])("rejects %s", (_label, value) => {
    const r = parseWebsiteUrl(value);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toBe(WEBSITE_URL_MESSAGE);
  });

  // A control character anywhere is refused even when the scheme is fine: we
  // store the caller's original, so an accepted value must be exactly what every
  // later consumer re-parses. A NUL additionally cannot be stored by Postgres at
  // all, and would surface as a raw driver error instead of our message.
  it.each([
    ["leading NUL on a valid url", "\u0000https://x.com"],
    ["trailing NUL on a valid url", "https://x.com\u0000"],
    ["tab inside the host", "https://x\t.com"],
    ["newline inside the path", "https://x.com/a\nb"],
    ["DEL inside the path", "https://x.com/a\u007fb"],
  ])("rejects %s", (_label, value) => {
    const r = parseWebsiteUrl(value);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toBe(WEBSITE_URL_MESSAGE);
  });

  // The scheme comparison is on the PARSED protocol, which the URL parser has
  // already lower-cased - so an upper-case http(s) scheme is legitimate and must
  // still be accepted, returned verbatim.
  it.each(["HTTP://X.COM", "HttPs://wallerracing.com.au", "Https://x.com/Path"])(
    "accepts %j and returns it unchanged",
    (value) => {
      expect(parseWebsiteUrl(value)).toEqual({ ok: true, value });
    },
  );
});
