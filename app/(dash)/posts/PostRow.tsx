"use client";

import { useRouter } from "next/navigation";
import { Icon } from "../icons";
import PostActions from "./PostActions";
import type { PostView } from "./types";

// One Posts-library row. The whole row is the way into the post detail
// (Compose in edit mode) — it replaces the old per-row Edit link. Clicks on
// the action affordances (Unpublish / Publish now / Discard …) act in place
// and never navigate.
export default function PostRow({ post: p }: { post: PostView }) {
  const router = useRouter();

  return (
    <tr
      className="row-link"
      tabIndex={0}
      aria-label={`Open ${p.title}`}
      onClick={(e) => {
        if ((e.target as HTMLElement).closest("a, button, .actions")) return;
        router.push(p.editHref);
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter" && e.target === e.currentTarget) router.push(p.editHref);
      }}
    >
      <td className="with-thumb">
        <div className="row-thumb">
          {p.thumbUrl ? (
            // eslint-disable-next-line @next/next/no-img-element -- remote Storage horse photo, CSS-cropped thumb
            <img src={p.thumbUrl} alt="" />
          ) : (
            <div className="thumb-fallback">
              <Icon name="horseHead" />
            </div>
          )}
        </div>
        <div>
          <div className="row-name">{p.title}</div>
          {p.excerpt && <div className="row-sub">{p.excerpt}</div>}
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
      <td className="nowrap">{p.whenLabel}</td>
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
