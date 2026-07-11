import Link from "next/link";
import { requireAdminPage } from "@/lib/auth/admin";
import { Icon } from "../icons";
import {
  formatCount,
  horseMeta,
  humanizeTrainingStatus,
  statusPillClass,
} from "./format";
import "./horses.css";

// Horses DB — screens/05-horses.html. Data-bearing (dash) page: it re-asserts
// requireAdminPage() rather than trusting the layout gate (Next renders layout
// + page in parallel and caches the layout across soft nav). Follower/post
// counts are derived via PostgREST embedded counts; age is computed, not stored.

const PAGE_SIZE = 12;

type CountEmbed = { count: number }[];
type HorseRow = {
  id: string;
  display_name: string;
  racing_name: string | null;
  stable_name: string | null;
  sex: string | null;
  colour: string | null;
  foaling_year: number | null;
  status: string | null;
  training_status: string | null;
  photo_url: string | null;
  trainer: { display_name: string | null } | { display_name: string | null }[] | null;
  follows: CountEmbed | null;
  posts: CountEmbed | null;
};

type Filter = "all" | "active" | "racing" | "retired";
const FILTERS: { key: Filter; label: string }[] = [
  { key: "all", label: "All" },
  { key: "active", label: "Active" },
  { key: "racing", label: "Racing" },
  { key: "retired", label: "Retired" },
];

function trainerName(t: HorseRow["trainer"]): string | null {
  if (!t) return null;
  const row = Array.isArray(t) ? t[0] : t;
  return row?.display_name ?? null;
}

function embedCount(e: CountEmbed | null): number {
  return e?.[0]?.count ?? 0;
}

function buildHref(p: { filter?: Filter; q?: string; page?: number }): string {
  const params = new URLSearchParams();
  if (p.filter && p.filter !== "all") params.set("filter", p.filter);
  if (p.q) params.set("q", p.q);
  if (p.page && p.page > 1) params.set("page", String(p.page));
  const s = params.toString();
  return s ? `/horses?${s}` : "/horses";
}

export default async function HorsesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { sb } = await requireAdminPage();
  const sp = await searchParams;
  const filter: Filter = (["all", "active", "racing", "retired"] as const).includes(
    sp.filter as Filter,
  )
    ? (sp.filter as Filter)
    : "all";
  const q = typeof sp.q === "string" ? sp.q.trim() : "";
  const requestedPage = Math.max(1, parseInt(typeof sp.page === "string" ? sp.page : "1", 10) || 1);

  let query = sb
    .from("horse")
    .select(
      "id, display_name, racing_name, stable_name, sex, colour, foaling_year, status, training_status, photo_url, created_at, trainer:trainer_id(display_name), follows:follow(count), posts:post(count)",
    )
    .order("created_at", { ascending: false });

  if (q) {
    const { data: trainers } = await sb.from("trainer").select("id").ilike("display_name", `%${q}%`);
    const trainerIds = ((trainers ?? []) as { id: string }[]).map((t) => t.id);
    // Strip PostgREST logical-tree separators so a comma/paren in `q` cannot
    // splice extra OR terms. (`.ilike()` above is parameterized and safe.)
    const safeQ = q.replace(/[,()]/g, " ");
    const ors = [
      `display_name.ilike.%${safeQ}%`,
      `racing_name.ilike.%${safeQ}%`,
      `stable_name.ilike.%${safeQ}%`,
    ];
    if (trainerIds.length) ors.push(`trainer_id.in.(${trainerIds.join(",")})`);
    query = query.or(ors.join(","));
  }

  const { data } = await query;
  const all = (data ?? []) as HorseRow[];

  const counts = {
    all: all.length,
    active: all.filter((h) => h.training_status !== "retired").length,
    racing: all.filter((h) => h.training_status === "racing").length,
    retired: all.filter((h) => h.training_status === "retired").length,
  };

  const filtered = all.filter((h) => {
    if (filter === "active") return h.training_status !== "retired";
    if (filter === "racing") return h.training_status === "racing";
    if (filter === "retired") return h.training_status === "retired";
    return true;
  });

  const total = filtered.length;
  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const current = Math.min(requestedPage, pageCount);
  const start = (current - 1) * PAGE_SIZE;
  const shown = filtered.slice(start, start + PAGE_SIZE);

  return (
    <>
      <div className="admin-topbar">
        <h1>Horses</h1>
        <div className="actions">
          <form className="search" action="/horses" method="get">
            {filter !== "all" && <input type="hidden" name="filter" value={filter} />}
            <Icon name="search" />
            <input name="q" defaultValue={q} placeholder="Search horses…" aria-label="Search horses" />
          </form>
          <Link href="/horses/new" className="btn btn-primary" style={{ padding: "8px 16px", fontSize: "13.5px" }}>
            + Add horse
          </Link>
        </div>
      </div>

      <div className="admin-content">
        <div className="adm-card">
          <div className="adm-filter-bar">
            {FILTERS.map((f) => (
              <Link
                key={f.key}
                href={buildHref({ filter: f.key, q })}
                className={f.key === filter ? "chip active" : "chip"}
              >
                {f.label}
                <strong style={{ marginLeft: 4, opacity: 0.7 }}>{counts[f.key]}</strong>
              </Link>
            ))}
            <div className="spacer" />
            <form className="search-mini" action="/horses" method="get">
              {filter !== "all" && <input type="hidden" name="filter" value={filter} />}
              <Icon name="search" />
              <input name="q" defaultValue={q} placeholder="Filter by trainer or stable…" aria-label="Filter horses" />
            </form>
          </div>

          {shown.length === 0 ? (
            <div className="horse-empty">
              <h2>{q || filter !== "all" ? "No horses match" : "No horses yet"}</h2>
              <p>
                {q || filter !== "all"
                  ? "Try a different filter or search."
                  : "Add your first horse to start building the library."}
              </p>
              <Link href="/horses/new" className="btn btn-primary" style={{ padding: "10px 22px" }}>
                + Add horse
              </Link>
            </div>
          ) : (
            <>
              <div style={{ padding: 20 }}>
                <div className="horse-grid-adm">
                  {shown.map((h) => (
                    <Link key={h.id} href={`/horses/${h.id}/edit`} className="horse-card-adm">
                      <div className="cover">
                        {h.photo_url ? (
                          // eslint-disable-next-line @next/next/no-img-element -- remote Storage photo; mockup uses a plain cover img
                          <img src={h.photo_url} alt="" />
                        ) : (
                          <div className="cover-fallback">
                            <Icon name="horseHead" />
                          </div>
                        )}
                      </div>
                      <div className="body">
                        <p className="name">{h.display_name}</p>
                        <div className="meta">
                          {horseMeta({
                            trainerName: trainerName(h.trainer),
                            foalingYear: h.foaling_year,
                            sex: h.sex,
                            trainingStatus: h.training_status,
                          })}
                        </div>
                        <div className="stats">
                          <span>
                            <strong>{formatCount(embedCount(h.follows))}</strong> followers
                          </span>
                          <span>
                            <strong>{formatCount(embedCount(h.posts))}</strong> posts
                          </span>
                        </div>
                        <div style={{ marginTop: 10 }}>
                          <span className={statusPillClass(h.training_status)}>
                            {humanizeTrainingStatus(h.training_status)}
                          </span>
                        </div>
                      </div>
                    </Link>
                  ))}
                </div>
              </div>

              <div className="horse-grid-foot">
                <div>
                  Showing {shown.length} of {total} horses
                </div>
                <div className="pager">
                  {current > 1 ? (
                    <Link href={buildHref({ filter, q, page: current - 1 })}>‹ Prev</Link>
                  ) : (
                    <span className="disabled">‹ Prev</span>
                  )}
                  {current < pageCount ? (
                    <Link href={buildHref({ filter, q, page: current + 1 })}>Next ›</Link>
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
