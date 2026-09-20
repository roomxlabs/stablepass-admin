"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Icon } from "../icons";
import LocalTime from "../LocalTime";
import PostActions from "./PostActions";
import PosterFrameEditor from "./PosterFrameEditor";
import { whenIso } from "./format";
import type { PostView } from "./types";
import type { Subject } from "@/lib/posts/subject";

/** Thumb-fallback glyph per subject (ENG-1269). */
const SUBJECT_ICON: Record<Subject, "horseHead" | "user" | "bookmark"> = {
  horse: "horseHead",
  trainer: "user",
  stablepass: "bookmark",
};

// One Posts-library row. The whole row is the way into the post detail
// (Compose in edit mode) — it replaces the old per-row Edit link. Clicks on
// the action affordances (Unpublish / Publish now / Discard / Choose preview
// frame …) act in place and never navigate.
export default function PostRow({ post: p }: { post: PostView }) {
  const router = useRouter();
  // Local thumb override after a successful poster re-bake (ENG-825) so the
  // new versioned poster_url shows before router.refresh() finishes.
  const [overrideThumb, setOverrideThumb] = useState<string | null>(null);
  const thumbUrl = overrideThumb ?? p.thumbUrl;
  // The "Published" instant, by status. Drafts (and rows missing the relevant
  // timestamp) have none → "—". <LocalTime> renders it in the browser TZ.
  const iso = whenIso(p);

  return (
    <tr
      className="row-link"
      tabIndex={0}
      aria-label={`Open ${p.title}`}
      onClick={(e) => {
        if ((e.target as HTMLElement).closest("a, button, .actions, .poster-frame-editor")) return;
        router.push(p.editHref);
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter" && e.target === e.currentTarget) router.push(p.editHref);
      }}
    >
      <td className="with-thumb">
        <div className="row-thumb">
          {thumbUrl ? (
            // eslint-disable-next-line @next/next/no-img-element -- remote Storage horse photo, CSS-cropped thumb
            <img src={thumbUrl} alt="" data-testid="post-thumb" />
          ) : (
            /* ENG-1269 — the fallback glyph follows the SUBJECT. A horse head
               on a trainer or StablePass post reads as "this is about a horse
               whose photo is missing", which is the one thing the row exists to
               tell the operator it is not. */
            <div className="thumb-fallback">
              <Icon name={SUBJECT_ICON[p.subject.subject]} />
            </div>
          )}
        </div>
        <div>
          <div className="row-name">{p.title}</div>
          {p.excerpt && <div className="row-sub">{p.excerpt}</div>}
          {p.type === "video" && p.playbackUrl ? (
            <PosterFrameEditor
              postId={p.id}
              playbackUrl={p.playbackUrl}
              posterTimeS={p.posterTimeS}
              onPosterUpdated={(displayUrl) => {
                if (displayUrl) setOverrideThumb(displayUrl);
              }}
            />
          ) : null}
        </div>
      </td>
      {/* "Posted as" (ENG-1269) — horse name / trainer name + a "Trainer" tag /
          `stablepass` over its byline. One <strong> line plus an optional muted
          sub-line in every case, so the three subjects sit on the same baseline
          and the column does not change height per row. */}
      <td className="subject-cell" data-testid="post-subject">
        <strong className="subject-name">{p.subject.name}</strong>
        {/* The tag sits on the SUB-LINE, not beside the name. Inline, the
            cell's min-content became `name + tag` on one unbreakable line
            (~180px), and `table-layout: auto` took that width out of the Post
            column — whose `width: 44%` is only a hint — so every excerpt wrapped
            to 5-7 lines and the library lost half its row density. On its own
            line the cell is as narrow as the longest single name again, and the
            two-line shape is identical for all three subjects. */}
        {(p.subject.tag || p.subject.detail) && (
          <div className="row-sub subject-sub">
            {p.subject.tag && <span className="subject-tag">{p.subject.tag}</span>}
            {p.subject.detail}
          </div>
        )}
      </td>
      <td className="nowrap">
        <span className="pill">{p.typeLabel}</span>
      </td>
      <td className="nowrap">
        <span className={p.statusPillClass}>{p.statusLabel}</span>
      </td>
      <td className="nowrap">{iso ? <LocalTime kind="when" iso={iso} /> : "—"}</td>
      <td className="nowrap">
        {p.likeCount === null ? (
          "—"
        ) : (
          <>
            <strong>{p.likeCount}</strong> likes
          </>
        )}
      </td>
      <td className="actions">
        <PostActions id={p.id} status={p.status} />
      </td>
    </tr>
  );
}
