"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Icon } from "../icons";
import LocalTime from "../LocalTime";
import PostActions from "./PostActions";
import PosterFrameEditor from "./PosterFrameEditor";
import { whenIso } from "./format";
import type { PostView } from "./types";

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
            <div className="thumb-fallback">
              <Icon name="horseHead" />
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
      <td className="nowrap">
        <strong>{p.horseName}</strong>
        {p.trainerName && <div className="row-sub">{p.trainerName}</div>}
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
