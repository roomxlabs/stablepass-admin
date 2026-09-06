import Link from "next/link";
import SearchField from "../SearchField";
import SortableTh from "../SortableTh";
import type { SortDir } from "../list-href";
import PostRow from "./PostRow";
import { POST_SORT_COLUMNS, STATUS_FILTERS, buildPostsHref } from "./format";
import type { PostSort } from "@/lib/posts/sort";
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
  /** Active trainer scope from a `?trainerId=` deep-link (Trainers list jump). */
  trainerId?: string;
  /** Display name behind `trainerId`, for the scope bar. Null = stale link. */
  trainerName?: string | null;
  /** Active `?sort=` ("" = default `created_at desc`) and its direction. */
  sort?: PostSort | "";
  dir?: SortDir;
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
  trainerId = "",
  trainerName = null,
  sort = "",
  dir = "desc",
}: Props) {
  const prevOffset = Math.max(0, offset - limit);
  const nextOffset = offset + limit;
  const filtered = q !== "" || status !== "all" || horseId !== "" || trainerId !== "";

  // Everything the URL carries except `q` itself — so typing in either search
  // box keeps the status chip, the horse/trainer scope AND the sort. Missing
  // sort here is what would silently reset the table to `created_at desc` the
  // moment an operator refined their search (ENG-963).
  const hiddenParams: Record<string, string> = {
    ...(status !== "all" && { status }),
    ...(horseId && { horseId }),
    ...(trainerId && { trainerId }),
    ...(sort && { sort, dir }),
  };

  // Header links preserve every other param and only move sort/dir. Paging is
  // reset (no `offset`) on purpose: page 3 of an old order is not page 3 of the
  // new one, so staying on it would drop the operator into arbitrary rows.
  const sortHref = (column: string, nextDir: SortDir) =>
    buildPostsHref({ status, q, horseId, trainerId, sort: column as PostSort, dir: nextDir });

  const columnProps = (column: PostSort) => {
    const def = POST_SORT_COLUMNS.find((c) => c.column === column)!;
    return { column, label: def.label, defaultDir: def.defaultDir, sort, dir, hrefFor: sortHref };
  };

  return (
    <>
      <div className="admin-topbar">
        <h1>Posts library</h1>
        <div className="actions">
          <SearchField
            action="/posts"
            className="search search-form"
            placeholder="Search posts…"
            ariaLabel="Search posts"
            defaultValue={q}
            hidden={hiddenParams}
          />
          <Link href="/compose" className="btn btn-primary" style={{ padding: "8px 16px", fontSize: "13.5px" }}>
            + New post
          </Link>
        </div>
      </div>

      <div className="admin-content">
        <div className="adm-card">
          {trainerId ? (
            // Arrived from the Trainers list (posts ↔ horses two-way jump).
            // Mirrors the Horses list's scope bar exactly, including the
            // "show everything again" escape hatch — a scoped list with no way
            // out is how an operator concludes the library lost their posts.
            <div className="adm-scope-bar" data-testid="trainer-scope">
              <span>
                Showing posts by <strong>{trainerName ?? "an unknown trainer"}</strong>
              </span>
              <span className="scope-actions">
                <Link href={`/horses?trainerId=${encodeURIComponent(trainerId)}`} className="chip">
                  Their horses
                </Link>
                <Link href={buildPostsHref({ status, q, sort, dir })} className="chip">
                  Show all posts
                </Link>
              </span>
            </div>
          ) : null}
          <div className="adm-filter-bar">
            {STATUS_FILTERS.map((f) => (
              <Link
                key={f.key}
                href={buildPostsHref({ status: f.key, q, horseId, trainerId, sort, dir })}
                className={f.key === status ? "chip active" : "chip"}
              >
                {f.label}
                <strong style={{ marginLeft: 4, opacity: 0.7 }}>{counts[f.key]}</strong>
              </Link>
            ))}
            <div className="spacer" />
            <SearchField
              action="/posts"
              className="search-mini"
              placeholder="Filter by horse or trainer…"
              ariaLabel="Filter posts by horse or trainer"
              defaultValue={q}
              hidden={hiddenParams}
            />
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
                    {/* Horse / trainer is sortable; Type is not — a five-value
                        enum is what the chips are for. Order below matches the
                        cell order in <PostRow>. */}
                    <SortableTh {...columnProps("horse")} className="nowrap" />
                    <th className="nowrap">Type</th>
                    <SortableTh {...columnProps("status")} className="nowrap" />
                    <SortableTh {...columnProps("published")} className="nowrap" />
                    <SortableTh {...columnProps("engagement")} className="nowrap" />
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
                    <Link href={buildPostsHref({ status, q, horseId, trainerId, sort, dir, offset: prevOffset })}>
                      ‹ Prev
                    </Link>
                  ) : (
                    <span className="disabled">‹ Prev</span>
                  )}
                  {hasMore ? (
                    <Link href={buildPostsHref({ status, q, horseId, trainerId, sort, dir, offset: nextOffset })}>
                      Next ›
                    </Link>
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
