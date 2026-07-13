import Link from "next/link";
import { Icon } from "../icons";
import PostRow from "./PostRow";
import { STATUS_FILTERS, buildPostsHref } from "./format";
import type { PostView, StatusCounts, StatusFilter } from "./types";

// Presentational shell for the Posts library (screens/04-posts.html). Pure and
// synchronous — the async data read lives in page.tsx and injects props here,
// which keeps this table (filters / search / pagination / row actions) directly
// unit-testable. Chips + search + pagination are URL-driven (links + GET forms,
// the horses precedent); only the per-row actions are interactive (PostActions).
type Props = {
  posts: PostView[];
  status: StatusFilter;
  counts: StatusCounts;
  q: string;
  total: number;
  offset: number;
  limit: number;
  hasMore: boolean;
  /** Active horse scope from a `?horseId=` deep-link; preserved across nav. */
  horseId?: string;
};

export default function PostsLibrary({
  posts,
  status,
  counts,
  q,
  total,
  offset,
  limit,
  hasMore,
  horseId = "",
}: Props) {
  const prevOffset = Math.max(0, offset - limit);
  const nextOffset = offset + limit;
  const filtered = q !== "" || status !== "all" || horseId !== "";

  return (
    <>
      <div className="admin-topbar">
        <h1>Posts library</h1>
        <div className="actions">
          <form className="search search-form" action="/posts" method="get">
            {status !== "all" && <input type="hidden" name="status" value={status} />}
            {horseId && <input type="hidden" name="horseId" value={horseId} />}
            <Icon name="search" />
            <input name="q" defaultValue={q} placeholder="Search posts…" aria-label="Search posts" />
          </form>
          <Link href="/compose" className="btn btn-primary" style={{ padding: "8px 16px", fontSize: "13.5px" }}>
            + New post
          </Link>
        </div>
      </div>

      <div className="admin-content">
        <div className="adm-card">
          <div className="adm-filter-bar">
            {STATUS_FILTERS.map((f) => (
              <Link
                key={f.key}
                href={buildPostsHref({ status: f.key, q, horseId })}
                className={f.key === status ? "chip active" : "chip"}
              >
                {f.label}
                <strong style={{ marginLeft: 4, opacity: 0.7 }}>{counts[f.key]}</strong>
              </Link>
            ))}
            <div className="spacer" />
            <form className="search-mini" action="/posts" method="get">
              {status !== "all" && <input type="hidden" name="status" value={status} />}
              {horseId && <input type="hidden" name="horseId" value={horseId} />}
              <Icon name="search" />
              <input
                name="q"
                defaultValue={q}
                placeholder="Filter by horse or trainer…"
                aria-label="Filter posts by horse or trainer"
              />
            </form>
          </div>

          {posts.length === 0 ? (
            <div className="posts-empty">
              <h2>{filtered ? "No posts match" : "No posts yet"}</h2>
              <p>
                {filtered
                  ? "Try a different filter or search term."
                  : "Publish your first post from Compose to build the library."}
              </p>
              <Link href="/compose" className="btn btn-primary" style={{ padding: "10px 22px" }}>
                + New post
              </Link>
            </div>
          ) : (
            <>
              <table className="adm-table">
                <thead>
                  <tr>
                    <th style={{ width: "44%" }}>Post</th>
                    <th className="nowrap">Horse / trainer</th>
                    <th className="nowrap">Type</th>
                    <th className="nowrap">Status</th>
                    <th className="nowrap">Published</th>
                    <th className="nowrap">Engagement</th>
                    <th aria-label="Actions" />
                  </tr>
                </thead>
                <tbody>
                  {posts.map((p) => (
                    <PostRow key={p.id} post={p} />
                  ))}
                </tbody>
              </table>

              <div className="adm-help" style={{ padding: "12px 22px 0" }}>
                Unpublish is a soft hide — it removes the post from member feeds but keeps it here, and you
                can republish it any time. It is not a delete.
              </div>

              <div className="posts-foot">
                <div>
                  Showing {posts.length} of {total} posts
                </div>
                <div className="pager">
                  {offset > 0 ? (
                    <Link href={buildPostsHref({ status, q, horseId, offset: prevOffset })}>‹ Prev</Link>
                  ) : (
                    <span className="disabled">‹ Prev</span>
                  )}
                  {hasMore ? (
                    <Link href={buildPostsHref({ status, q, horseId, offset: nextOffset })}>Next ›</Link>
                  ) : (
                    <span className="disabled">Next ›</span>
                  )}
                </div>
              </div>
            </>
          )}
        </div>
      </div>
    </>
  );
}
