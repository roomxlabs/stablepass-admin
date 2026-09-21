import { describe, it, expect } from "vitest";
import { mapPostRow, POST_SORT_COLUMNS } from "./format";
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
    subject: "horse",
    horse_id: "h1",
    byline: null,
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
    expect(v.subject.name).toBe("Mahogany");
    expect(v.subject.detail).toBe("Chris Waller");
    expect(v.excerpt).toBe("Morning at Caulfield.");
    expect(v.likeCount).toBe(12);
    expect(v.editHref).toBe("/compose?id=p1");
  });
});

// ---------------------------------------------------------------------------
// ENG-1269 — `mapPostRow`'s `subject`, one case per subject.
//
// `lib/posts/subject.test.ts` pins `subjectLabel` itself; these pin that
// `mapPostRow` feeds it the right fields, INCLUDING this screen's own
// precedence for the horse name (`display_name` before `racing_name` — the
// opposite order from the preview route and analytics, both of which prefer
// `racing_name`) and its "Unassigned" fallback.
// ---------------------------------------------------------------------------
describe("mapPostRow — subject (ENG-1269)", () => {
  it("horse: names the horse by display_name over racing_name, with the trainer as detail", () => {
    const v = mapPostRow(
      row({
        subject: "horse",
        horse: { display_name: "Mahogany", racing_name: "MAHOGANY (AUS)", photo_url: null },
        trainer: { name: "Chris Waller" },
      }),
    );
    expect(v.subject).toEqual({
      subject: "horse",
      name: "Mahogany",
      tag: null,
      detail: "Chris Waller",
      text: "Mahogany",
    });
  });

  it("horse: falls back to racing_name when display_name is empty, then to 'Unassigned'", () => {
    const withRacingName = mapPostRow(
      row({ horse: { display_name: null, racing_name: "MAHOGANY (AUS)", photo_url: null } }),
    );
    expect(withRacingName.subject.name).toBe("MAHOGANY (AUS)");

    const withNeither = mapPostRow(row({ horse: null, trainer: null }));
    expect(withNeither.subject.name).toBe("Unassigned");
    expect(withNeither.subject.detail).toBeNull();
  });

  // ENG-1295 — the `.trim()` at format.ts's `horseName` had no proof: the case
  // above only covers `display_name: null`, which passes with or without it.
  //
  // The BE's `subject_name` computed column — what the "Posted as" sort orders
  // by — is `coalesce(nullif(btrim(display_name),''), nullif(btrim(racing_name),''))`,
  // so it treats a whitespace-only `display_name` as ABSENT and sorts the row
  // under the racing name. Without the trim here, `"   "` is truthy at the
  // `||`, short-circuits the fallback, and `subjectLabel`'s own `clean()`
  // renders "Unassigned" — the list ordered by a string the operator cannot
  // see. These two pin the cell to the same resolution as the SQL.
  //
  // Which is which: the whitespace-only case is the MUTATION GUARD — delete the
  // `.trim()` and it, alone in the whole suite, goes red. The padded case is
  // the acceptance criterion restated (trim changes the padding, not which
  // name wins); `subjectLabel`'s own `clean()` would trim it anyway, so it
  // survives that mutation. Do not delete the whitespace case thinking the
  // padded one covers it.
  it("horse: a whitespace-only display_name is ABSENT, so the cell reads the racing name (not 'Unassigned')", () => {
    const v = mapPostRow(
      row({ horse: { display_name: "   ", racing_name: "MAHOGANY (AUS)", photo_url: null } }),
    );
    expect(v.subject.name).toBe("MAHOGANY (AUS)");
    expect(v.subject.name).not.toBe("Unassigned");
    expect(v.subject.text).toBe("MAHOGANY (AUS)");
  });

  it("horse: a padded display_name renders trimmed and still wins over racing_name", () => {
    const v = mapPostRow(
      row({ horse: { display_name: "  Mahogany  ", racing_name: "MAHOGANY (AUS)", photo_url: null } }),
    );
    expect(v.subject.name).toBe("Mahogany");
  });

  it("trainer: names the trainer and tags it, with no horse to name", () => {
    const v = mapPostRow(
      row({ subject: "trainer", horse_id: null, horse: null, trainer: { name: "Chris Waller" } }),
    );
    expect(v.subject).toEqual({
      subject: "trainer",
      name: "Chris Waller",
      tag: "Trainer",
      detail: null,
      text: "Chris Waller · Trainer",
    });
  });

  it("stablepass: names the brand handle, with the byline as detail", () => {
    const v = mapPostRow(
      row({ subject: "stablepass", horse_id: null, horse: null, trainer: null, byline: "Racing TV" }),
    );
    expect(v.subject).toEqual({
      subject: "stablepass",
      name: "stablepass",
      tag: null,
      detail: "Racing TV",
      text: "stablepass · Racing TV",
    });
  });
});

describe("POST_SORT_COLUMNS", () => {
  it("labels the subject column 'Posted as' — it now names a horse, a trainer or StablePass", () => {
    const subjectColumn = POST_SORT_COLUMNS.find((c) => c.column === "subject");
    expect(subjectColumn?.label).toBe("Posted as");
  });
});
