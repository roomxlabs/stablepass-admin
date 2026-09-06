import { describe, it, expect } from "vitest";
import { mapPostRow } from "./format";
import type { PostRow } from "./types";

// ENG-979 — what names a row in the Posts library.
//
// The bug Mel demoed on 2 Sep: she typed her own title on a post and the
// library still said "Untitled post", so she could not tell her posts apart
// without opening each one. "If I open up a post and I want to know what I said
// there, I'd have to go into it to check rather than just popping up."
//
// `mapPostRow` is the whole of that decision and had NO test before this
// ticket, which is how the mismatch survived. These pin it.

function row(over: Partial<PostRow> = {}): PostRow {
  return {
    id: "p1",
    horse_id: "h1",
    type: "photo",
    status: "published",
    title: null,
    label: null,
    body: "Morning at Caulfield.",
    media_url: null,
    mux_playback_id: null,
    poster_url: null,
    poster_time_s: null,
    like_count: 12,
    published_at: "2026-07-11T00:00:00Z",
    scheduled_for: null,
    created_at: "2026-07-11T00:00:00Z",
    horse: { display_name: "Mahogany", racing_name: null, photo_url: null },
    trainer: { name: "Chris Waller" },
    ...over,
  };
}

describe("mapPostRow — the row's name", () => {
  it("shows the LABEL when the post has one", () => {
    // The acceptance criterion: "the post list shows that label instead of
    // 'Untitled post'".
    expect(mapPostRow(row({ label: "Trackwork" })).title).toBe("Trackwork");
  });

  it("prefers the label over a legacy title when the post has both", () => {
    // Compose offers one field now and it drives `label`, so the label is the
    // operator's current intent and the title is whatever was typed before.
    expect(mapPostRow(row({ label: "Trackwork", title: "Old typed title" })).title).toBe(
      "Trackwork",
    );
  });

  it("falls back to the legacy title for a pre-ENG-979 post with no label", () => {
    // The un-backfilled case, stated on the PR and the ticket. These rows are
    // Mel's live posts: a title she typed, and no label. Reading label-only
    // would have regressed exactly these to "Untitled post" — the symptom this
    // ticket exists to remove — and the only alternative was a backfill, which
    // is a data write the human owner has not approved.
    expect(mapPostRow(row({ label: null, title: "Last fast gallop" })).title).toBe(
      "Last fast gallop",
    );
  });

  it("still renders the empty state for a post with neither", () => {
    // "Untitled post" survives, but only for a post that is genuinely unnamed.
    expect(mapPostRow(row({ label: null, title: null })).title).toBe("Untitled post");
  });

  it("treats a whitespace-only label or title as absent", () => {
    expect(mapPostRow(row({ label: "   ", title: "   " })).title).toBe("Untitled post");
    expect(mapPostRow(row({ label: "   ", title: "Real title" })).title).toBe("Real title");
  });

  it("trims a padded label rather than rendering the padding", () => {
    expect(mapPostRow(row({ label: "  Trackwork  " })).title).toBe("Trackwork");
  });

  it("renders a runtime-added label like any other — the list is not pinned to the presets", () => {
    // A category Mel created through Add-new is in no compile-time array in
    // this repo. If the library validated against `POST_LABEL_PRESETS` it would
    // fall back to "Untitled post" for precisely the labels this epic adds.
    expect(mapPostRow(row({ label: "Owner Update" })).title).toBe("Owner Update");
  });

  it("leaves the rest of the mapping alone", () => {
    // A guard against the label change quietly disturbing the row model.
    const v = mapPostRow(row({ label: "Trackwork" }));
    expect(v.horseName).toBe("Mahogany");
    expect(v.trainerName).toBe("Chris Waller");
    expect(v.excerpt).toBe("Morning at Caulfield.");
    expect(v.likeCount).toBe(12);
    expect(v.editHref).toBe("/compose?id=p1");
  });
});
