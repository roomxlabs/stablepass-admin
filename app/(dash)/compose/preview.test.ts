// Unit cover for the compose preview's pure helpers (ENG-558): the clamp that
// decides the preview box, the readout copy, and the racing-name casing.
import { describe, expect, it } from "vitest";
import {
  ASPECT_DEFAULT,
  ASPECT_MAX,
  ASPECT_MIN,
  REEL_ASPECT_MIN,
  aestToday,
  describeOrientation,
  displayHorseName,
  resolveAspect,
} from "./types";

describe("resolveAspect", () => {
  it("uses the file's own ratio when it is inside what members see", () => {
    expect(resolveAspect({ width: 1920, height: 1080 })).toBeCloseTo(1.7778, 4);
    expect(resolveAspect({ width: 1000, height: 1000 })).toBe(1);
  });

  it("still clamps a portrait NON-video to 4:5", () => {
    // No media type = a text post (ComposeScreen reports text as null). The
    // classic floor is unchanged for everything that is not a portrait video.
    expect(resolveAspect({ width: 1080, height: 1920 })).toBe(ASPECT_MIN);
    expect(resolveAspect({ width: 1080, height: 1920 })).toBe(0.8);
  });

  it("draws a portrait VIDEO as a reel at its own ratio, down to 9:16 (ENG-747)", () => {
    // The regression this ticket reopened: the member card has drawn a
    // portrait video at its raw ratio since 18 Aug 2026, while this preview
    // was still flooring it at 4:5 — so the operator vetted a crop that no
    // member would ever see.
    expect(resolveAspect({ width: 1080, height: 1920 }, "video")).toBe(REEL_ASPECT_MIN);
    expect(resolveAspect({ width: 1080, height: 1920 }, "video")).toBeCloseTo(0.5625, 6);
    // Between 4:5 and square nothing changes — reel and classic agree.
    expect(resolveAspect({ width: 1080, height: 1350 }, "video")).toBe(0.8);
    // Taller than 9:16 IS floored, exactly as the member card floors it.
    expect(resolveAspect({ width: 1080, height: 2400 }, "video")).toBe(REEL_ASPECT_MIN);
    // A portrait PHOTO is untouched by the reel rule: still the 16:10 box.
    expect(resolveAspect({ width: 1080, height: 1920 }, "photo")).toBe(ASPECT_DEFAULT);
  });

  it("pins the reel floor to the member card's 9:16", () => {
    // Duplicated constant, separate repos: if mobile's REEL_ASPECT_MIN moves,
    // this is the line that should force someone to look here too.
    expect(REEL_ASPECT_MIN).toBe(9 / 16);
  });

  it("clamps ultra-wide to 1.91:1", () => {
    expect(resolveAspect({ width: 2350, height: 1000 })).toBe(ASPECT_MAX);
    expect(resolveAspect({ width: 2350, height: 1000 })).toBe(1.91);
  });

  it("falls back to 16:10 when the file cannot be measured", () => {
    expect(resolveAspect(null)).toBe(ASPECT_DEFAULT);
    expect(resolveAspect(null)).toBe(1.6);
    expect(resolveAspect({ width: 0, height: 0 })).toBe(1.6);
    expect(resolveAspect({ width: -1920, height: 1080 })).toBe(1.6);
    expect(resolveAspect({ width: 1920, height: 0 })).toBe(1.6);
  });

  it("ALWAYS gives a photo 16:10, so the box agrees with the readout", () => {
    // A photo has no Mux asset, so the member app has no aspect_ratio for it
    // and renders it at 16:10 by construction. Drawing it at its own ratio
    // here would contradict the "Members see it at 16:10" line above it.
    expect(resolveAspect({ width: 1920, height: 1080 }, "photo")).toBe(1.6);
    expect(resolveAspect({ width: 1080, height: 1920 }, "photo")).toBe(1.6);
    expect(resolveAspect({ width: 1000, height: 1000 }, "photo")).toBe(1.6);
    // ...whereas the same sizes as VIDEO keep their own clamped ratio.
    expect(resolveAspect({ width: 1000, height: 1000 }, "video")).toBe(1);
  });
});

describe("describeOrientation", () => {
  it("names a landscape video and promises the same ratio", () => {
    expect(describeOrientation({ width: 1920, height: 1080 }, "video")).toBe(
      "1920×1080 · Landscape 16:9 · Members see it at 16:9",
    );
  });

  it("tells the truth about a portrait reel: uncropped at 9:16 (ENG-747)", () => {
    expect(describeOrientation({ width: 1080, height: 1920 }, "video")).toBe(
      "1080×1920 · Portrait 9:16 · Members see it as a reel at 9:16",
    );
  });

  it("warns only when a reel is TALLER than 9:16, which is the only real crop", () => {
    expect(describeOrientation({ width: 1080, height: 2400 }, "video")).toBe(
      "1080×2400 · Portrait 9:20 · Members see it as a reel, cropped to 9:16",
    );
  });

  it("never says 'cropped to 4:5' about a video again — that promise is dead", () => {
    // The exact drift this ticket exists to kill. Sweep the whole portrait
    // range rather than one sample, so a partial revert cannot pass.
    for (const height of [1350, 1400, 1600, 1920, 2200, 2400, 3000]) {
      expect(describeOrientation({ width: 1080, height }, "video")).not.toContain(
        "cropped to 4:5",
      );
    }
  });

  it("applies the reel copy to VIDEO only — the sibling guard to resolveAspect's", () => {
    // resolveAspect's `mediaType === "video"` is pinned by its own test; this
    // pins describeOrientation's identical guard. Without it that guard can be
    // widened to `!== "photo"` and the suite stays green while the sentence
    // ("as a reel") and the box (still 0.8) contradict each other — the exact
    // bug class this ticket exists to kill. Not reachable from the real screen
    // today (voice sets measure "off", text has no media box), so this is
    // defence in depth: the box must not depend on an upstream gate.
    expect(describeOrientation({ width: 1080, height: 1920 }, null)).toBe(
      "1080×1920 · Portrait 9:16 · Members see it cropped to 4:5",
    );
    expect(resolveAspect({ width: 1080, height: 1920 }, null)).toBe(ASPECT_MIN);
  });

  it("keeps a portrait PHOTO on the 16:10 story — the reel rule is video-only", () => {
    expect(describeOrientation({ width: 1080, height: 1920 }, "photo")).toBe(
      "1080×1920 · Portrait 9:16 · Members see it cropped to 16:10",
    );
  });

  it("names a square video", () => {
    expect(describeOrientation({ width: 1080, height: 1080 }, "video")).toBe(
      "1080×1080 · Square 1:1 · Members see it at 1:1",
    );
  });

  it("says 16:10 for a photo whatever its real size — photos carry no Mux aspect", () => {
    // A photo already at ~16:10 is shown as-is...
    expect(describeOrientation({ width: 1600, height: 1000 }, "photo")).toBe(
      "1600×1000 · Landscape 8:5 · Members see it at 16:10",
    );
    // ...and one that isn't is CROPPED into that box by object-fit: cover.
    // Saying only "at 16:10" would hide the crop on the photo path, which is
    // the same harm the ticket exists to surface on the video path.
    expect(describeOrientation({ width: 1920, height: 1080 }, "photo")).toBe(
      "1920×1080 · Landscape 16:9 · Members see it cropped to 16:10",
    );
    expect(describeOrientation({ width: 1080, height: 1920 }, "photo")).toBe(
      "1080×1920 · Portrait 9:16 · Members see it cropped to 16:10",
    );
  });

  it("warns that ultra-wide will be cropped", () => {
    expect(describeOrientation({ width: 2350, height: 1000 }, "video")).toContain(
      "Members see it cropped to 1.91:1",
    );
  });

  it("degrades honestly when the file cannot be measured", () => {
    const copy = "Dimensions unavailable · Members see it at 16:10";
    expect(describeOrientation(null, "video")).toBe(copy);
    expect(describeOrientation({ width: 0, height: 0 }, "video")).toBe(copy);
  });

  it("never contradicts itself on a near-square file", () => {
    // 1080x1081 is portrait by a hair, so a raw-float orientation word printed
    // "Portrait 1:1" — a line that argues with itself and tells the operator
    // nothing. The word is derived from the ratio actually printed.
    expect(describeOrientation({ width: 1080, height: 1081 }, "video")).toBe(
      "1080×1081 · Square 1:1 · Members see it at 1:1",
    );
    expect(describeOrientation({ width: 1081, height: 1080 }, "video")).toBe(
      "1081×1080 · Square 1:1 · Members see it at 1:1",
    );
    // A file that really is portrait still says so.
    expect(describeOrientation({ width: 1080, height: 1350 }, "video")).toBe(
      "1080×1350 · Portrait 4:5 · Members see it at 4:5",
    );
  });

  it("falls back to a decimal ratio when the size does not reduce cleanly", () => {
    // 1234:567 is coprime-ish noise; a decimal reads better than the raw pair.
    expect(describeOrientation({ width: 1234, height: 567 }, "video")).toBe(
      "1234×567 · Landscape 2.18:1 · Members see it cropped to 1.91:1",
    );
  });
});

describe("displayHorseName", () => {
  it("title-cases a registered ALL-CAPS racing name", () => {
    expect(displayHorseName("CANNONBROOK (AUS)")).toBe("Cannonbrook (AUS)");
  });

  it("leaves the registrar country code alone", () => {
    expect(displayHorseName("WINX (AUS)")).toBe("Winx (AUS)");
  });

  it("restarts capitalisation after an apostrophe or hyphen", () => {
    expect(displayHorseName("D'ARGENTO")).toBe("D'Argento");
    expect(displayHorseName("RED-HOT")).toBe("Red-Hot");
  });

  it("leaves a deliberately-cased name untouched", () => {
    expect(displayHorseName("Mahogany")).toBe("Mahogany");
    expect(displayHorseName("Verry Elleegant")).toBe("Verry Elleegant");
  });
});

describe("aestToday", () => {
  it("rolls to the next date once it is tomorrow in Sydney (AEST, UTC+10)", () => {
    // 2026-08-18T20:00Z is 2026-08-19 06:00 AEST.
    expect(aestToday(new Date("2026-08-18T20:00:00Z"))).toBe("2026-08-19");
    // 2026-08-18T09:00Z is still 2026-08-18 19:00 AEST.
    expect(aestToday(new Date("2026-08-18T09:00:00Z"))).toBe("2026-08-18");
  });

  it("follows daylight saving (AEDT, UTC+11) — a fixed +10 gets this wrong", () => {
    // 2026-11-01T13:30Z is 2026-11-02 00:30 AEDT: already the next race day.
    // A fixed UTC+10 would answer "2026-11-01" and hide the badge for horses
    // that are, in fact, racing — for the first hour of every DST day.
    expect(aestToday(new Date("2026-11-01T13:30:00Z"))).toBe("2026-11-02");
    // ...and the hour before the same instant is still the previous day.
    expect(aestToday(new Date("2026-11-01T12:30:00Z"))).toBe("2026-11-01");
  });
});
