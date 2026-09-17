import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import {
  addMonthsUtc,
  COMP_DURATIONS,
  grantPromotional,
  isCompDuration,
  revokePromotional,
  RevenueCatError,
  type CompDuration,
  type FetchImpl,
} from "./revenuecat";

const UID = "3f2b8c1e-5a4d-4e7f-9b6a-2c1d0e9f8a7b";
const NOW = new Date("2026-01-31T10:20:30.000Z");

function okFetch(status = 201) {
  return vi.fn<FetchImpl>(async () => new Response("{}", { status }));
}

beforeEach(() => {
  vi.stubEnv("REVENUECAT_SECRET_API_KEY", "sk_test_secret");
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

describe("grantPromotional", () => {
  it("POSTs the content entitlement's promotional endpoint with the Bearer key and end_time_ms", async () => {
    const f = okFetch(201);
    const out = await grantPromotional(UID, "three_month", f, { now: NOW });

    expect(f).toHaveBeenCalledTimes(1);
    const [url, init] = f.mock.calls[0];
    expect(url).toBe(`https://api.revenuecat.com/v1/subscribers/${UID}/entitlements/content/promotional`);
    expect(init?.method).toBe("POST");
    expect((init?.headers as Record<string, string>).Authorization).toBe("Bearer sk_test_secret");
    // 31 Jan + 3 months clamps to 30 Apr, time of day kept.
    const end = Date.parse("2026-04-30T10:20:30.000Z");
    expect(JSON.parse(String(init?.body))).toEqual({ end_time_ms: end });
    expect(out.endTimeMs).toBe(end);
  });

  it.each<[CompDuration, string]>([
    ["monthly", "2026-02-28T10:20:30.000Z"],
    ["two_month", "2026-03-31T10:20:30.000Z"],
    ["six_month", "2026-07-31T10:20:30.000Z"],
    ["yearly", "2027-01-31T10:20:30.000Z"],
  ])("%s → %s", async (duration, iso) => {
    const f = okFetch();
    await grantPromotional(UID, duration, f, { now: NOW });
    expect(JSON.parse(String(f.mock.calls[0][1]?.body))).toEqual({ end_time_ms: Date.parse(iso) });
  });

  it.each(["lifetime", "daily", "weekly", "toString", "__proto__", ""])(
    "rejects %j before any fetch",
    async (bad) => {
      const f = okFetch();
      await expect(grantPromotional(UID, bad as CompDuration, f, { now: NOW })).rejects.toMatchObject({
        name: "RevenueCatError",
        kind: "invalid_duration",
      });
      expect(f).not.toHaveBeenCalled();
    },
  );

  it("throws not_configured without the key, and sends nothing", async () => {
    vi.stubEnv("REVENUECAT_SECRET_API_KEY", "");
    const f = okFetch();
    await expect(grantPromotional(UID, "monthly", f)).rejects.toMatchObject({ kind: "not_configured" });
    expect(f).not.toHaveBeenCalled();
  });

  it("a non-2xx answer throws a typed unavailable error carrying the status", async () => {
    const f = okFetch(500);
    const err = await grantPromotional(UID, "monthly", f).catch((e) => e);
    expect(err).toBeInstanceOf(RevenueCatError);
    expect(err.kind).toBe("unavailable");
    expect(err.status).toBe(500);
  });

  it("a 4xx is also unavailable (the route answers 502, nothing changed)", async () => {
    await expect(grantPromotional(UID, "monthly", okFetch(400))).rejects.toMatchObject({ kind: "unavailable" });
  });

  it("a network error throws a typed unavailable error", async () => {
    const f = vi.fn<FetchImpl>(async () => {
      throw new TypeError("fetch failed");
    });
    await expect(grantPromotional(UID, "monthly", f)).rejects.toMatchObject({ kind: "unavailable" });
  });

  it("times out after timeoutMs by aborting the request → typed unavailable error", async () => {
    vi.useFakeTimers();
    const f = vi.fn<FetchImpl>(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
        }),
    );
    const p = grantPromotional(UID, "monthly", f, { timeoutMs: 5000 }).catch((e) => e);
    await vi.advanceTimersByTimeAsync(4999);
    expect(f.mock.calls[0][1]?.signal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    const err = await p;
    expect(err).toBeInstanceOf(RevenueCatError);
    expect(err.kind).toBe("unavailable");
    expect(err.message).toMatch(/timed out after 5000ms/);
  });

  it("percent-encodes the uid so a path cannot be smuggled into the URL", async () => {
    const f = okFetch();
    await grantPromotional("../../projects", "monthly", f);
    expect(f.mock.calls[0][0]).toBe(
      "https://api.revenuecat.com/v1/subscribers/..%2F..%2Fprojects/entitlements/content/promotional",
    );
  });
});

describe("revokePromotional", () => {
  it("POSTs revoke_promotionals with the Bearer key and no body", async () => {
    const f = okFetch(200);
    await revokePromotional(UID, f);
    const [url, init] = f.mock.calls[0];
    expect(url).toBe(`https://api.revenuecat.com/v1/subscribers/${UID}/entitlements/content/revoke_promotionals`);
    expect(init?.method).toBe("POST");
    expect((init?.headers as Record<string, string>).Authorization).toBe("Bearer sk_test_secret");
    expect(init?.body).toBeUndefined();
  });

  it("non-2xx → unavailable; missing key → not_configured before any fetch", async () => {
    await expect(revokePromotional(UID, okFetch(503))).rejects.toMatchObject({ kind: "unavailable" });
    vi.stubEnv("REVENUECAT_SECRET_API_KEY", "");
    const f = okFetch();
    await expect(revokePromotional(UID, f)).rejects.toMatchObject({ kind: "not_configured" });
    expect(f).not.toHaveBeenCalled();
  });
});

describe("durations", () => {
  // Pinned by literal: the menu labels, the route's 400 and this list must agree.
  it("allows exactly the five month-based durations — never lifetime", () => {
    expect(COMP_DURATIONS).toEqual(["monthly", "two_month", "three_month", "six_month", "yearly"]);
    expect(isCompDuration("lifetime")).toBe(false);
    expect(isCompDuration(3)).toBe(false);
  });

  it("addMonthsUtc clamps to month end across a leap year", () => {
    expect(addMonthsUtc(new Date("2028-01-31T00:00:00Z"), 1).toISOString()).toBe("2028-02-29T00:00:00.000Z");
    expect(addMonthsUtc(new Date("2026-11-15T00:00:00Z"), 3).toISOString()).toBe("2027-02-15T00:00:00.000Z");
  });
});

// Guardrail 8 — the RevenueCat secret key stays server-side. Scans the SOURCE
// (the only thing that can put it in the client bundle), comments included,
// because a "use client" file that merely mentions the env name is one edit from
// reading it.
describe("guardrail 8: the RevenueCat secret never reaches a client file", () => {
  const ROOT = join(__dirname, "..");
  function walk(dir: string, out: string[] = []): string[] {
    for (const name of readdirSync(dir)) {
      if (["node_modules", ".next", ".git", ".claude", "e2e", "test-results"].includes(name)) continue;
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p, out);
      else if (/\.(ts|tsx|js|jsx|mjs)$/.test(name) && !/\.test\.(ts|tsx)$/.test(name)) out.push(p);
    }
    return out;
  }
  const clientFiles = [...walk(join(ROOT, "app")), ...walk(join(ROOT, "lib"))].filter((f) =>
    /^\s*["']use client["']/m.test(readFileSync(f, "utf8")),
  );

  it("found the client files (a vacuous scan would pass on nothing)", () => {
    expect(clientFiles.map((f) => relative(ROOT, f))).toContain("app/(dash)/subscribers/CompAccess.tsx");
  });

  it("no \"use client\" file names REVENUECAT_SECRET_API_KEY", () => {
    const hits = clientFiles.filter((f) => readFileSync(f, "utf8").includes("REVENUECAT_SECRET_API_KEY"));
    expect(hits.map((f) => relative(ROOT, f))).toEqual([]);
  });

  it("no \"use client\" file value-imports lib/revenuecat (import type only)", () => {
    const valueImport = /^\s*import\s+(?!type\s)[^;]*from\s+["'](@\/lib\/revenuecat|[./]+\/revenuecat)["']/m;
    const hits = clientFiles.filter((f) => valueImport.test(readFileSync(f, "utf8")));
    expect(hits.map((f) => relative(ROOT, f))).toEqual([]);
  });
});
