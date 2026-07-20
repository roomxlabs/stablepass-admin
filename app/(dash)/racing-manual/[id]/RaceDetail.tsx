"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  formatJumpTime,
  formatRaceDate,
  raceMeta,
  raceTitle,
  runnerStatusPill,
  sourcePill,
  statusPill,
  type RaceRow,
} from "../format";

// Manage one race (RF6 / ENG-180): correct fields, attach runners, record results,
// or delete. Corrections to a feed row are what set race.manual_override on the
// server, so the operator is told plainly what that flag buys them.

export type Runner = {
  id: string;
  race_id: string;
  horse_id: string;
  barrier: number | null;
  jockey: string | null;
  result: string | null;
  finish_position: number | null;
  entry_status: string | null;
  horse: { display_name: string; racing_name: string | null } | { display_name: string; racing_name: string | null }[] | null;
};

type HorseOption = { id: string; display_name: string; racing_name: string | null };

function horseName(h: Runner["horse"]): string {
  const row = Array.isArray(h) ? h[0] : h;
  return row?.racing_name ?? row?.display_name ?? "Unknown horse";
}

// `scheduled_at` is a UTC instant; <input type="datetime-local"> wants local wall time.
function toLocalInput(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export default function RaceDetail({
  race,
  runners,
  horses,
}: {
  race: RaceRow;
  runners: Runner[];
  horses: HorseOption[];
}) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const [edit, setEdit] = useState({
    venue: race.venue ?? "",
    raceDate: race.race_date?.slice(0, 10) ?? "",
    raceNumber: race.race_number != null ? String(race.race_number) : "",
    raceClass: race.race_class ?? "",
    distanceM: race.distance_m != null ? String(race.distance_m) : "",
    scheduledAt: toLocalInput(race.scheduled_at),
  });

  const [runner, setRunner] = useState({ horseId: "", barrier: "", jockey: "" });
  const [result, setResult] = useState<
    Record<string, { result: string; finishPosition: string; prizeCents: string }>
  >({});

  const src = sourcePill(race);
  const st = statusPill(race.status);
  const isFeedRow = race.source === "api";
  const attachable = horses.filter((h) => !runners.some((r) => r.horse_id === h.id));

  async function call(key: string, url: string, init: RequestInit, after?: () => void) {
    setError(null);
    setBusy(key);
    try {
      const res = await fetch(url, init);
      if (res.status === 204) {
        after?.();
        router.refresh();
        return;
      }
      const json = await res.json().catch(() => null);
      if (!res.ok) throw new Error(json?.error?.message ?? "That didn't work.");
      after?.();
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "That didn't work.");
    } finally {
      setBusy(null);
    }
  }

  const jsonInit = (method: string, body: unknown): RequestInit => ({
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  function saveCorrection(e: React.FormEvent) {
    e.preventDefault();
    void call(
      "correct",
      `/api/admin/races/${race.id}`,
      jsonInit("PATCH", {
        venue: edit.venue.trim(),
        raceDate: edit.raceDate,
        raceNumber: edit.raceNumber === "" ? null : Number(edit.raceNumber),
        raceClass: edit.raceClass.trim() || null,
        distanceM: edit.distanceM === "" ? null : Number(edit.distanceM),
        scheduledAt: edit.scheduledAt ? new Date(edit.scheduledAt).toISOString() : null,
      }),
    );
  }

  function attachRunner(e: React.FormEvent) {
    e.preventDefault();
    void call(
      "attach",
      `/api/admin/races/${race.id}/runners`,
      jsonInit("POST", {
        horseId: runner.horseId,
        barrier: runner.barrier || null,
        jockey: runner.jockey.trim() || null,
      }),
      () => setRunner({ horseId: "", barrier: "", jockey: "" }),
    );
  }

  function recordResult(rh: Runner) {
    const r = result[rh.id] ?? { result: "", finishPosition: "", prizeCents: "" };
    void call(
      `result-${rh.id}`,
      `/api/admin/race-horses/${rh.id}/result`,
      jsonInit("PATCH", {
        result: r.result.trim() || null,
        finishPosition: r.finishPosition || null,
        prizeCents: r.prizeCents || null,
      }),
    );
  }

  function deleteRace() {
    const warning = isFeedRow && !race.manual_override
      ? "Delete this race? It came from the feed and has not been corrected, so the next poll may re-create it."
      : "Delete this race? Its runners are removed too. This cannot be undone.";
    if (!window.confirm(warning)) return;
    void call("delete", `/api/admin/races/${race.id}`, { method: "DELETE" }, () =>
      router.push("/racing-manual"),
    );
  }

  const meta = raceMeta(race);

  return (
    <>
      <div className="admin-topbar">
        <h1>
          <Link href="/racing-manual" style={{ color: "inherit", textDecoration: "none" }}>
            Manual races
          </Link>{" "}
          / {raceTitle(race)}
        </h1>
        <div className="actions">
          <button
            type="button"
            className="btn btn-danger"
            style={{ padding: "8px 16px", fontSize: "13.5px" }}
            onClick={deleteRace}
            disabled={busy !== null}
          >
            {busy === "delete" ? "Deleting…" : "Delete race"}
          </button>
        </div>
      </div>

      <div className="admin-content">
        <div className="rm-form-wrap">
          {error ? <div className="form-error" role="alert">{error}</div> : null}

          {/* Summary ------------------------------------------------- */}
          <div className="adm-card">
            <div className="adm-card-head">
              <div>
                <h2>{raceTitle(race)}</h2>
                <p className="sub">{meta || "No class or distance recorded"}</p>
              </div>
              <div className="tag-stack" style={{ display: "inline-flex", gap: 6 }}>
                <span className={src.className}>{src.label}</span>
                <span className={st.className}>{st.label}</span>
              </div>
            </div>
            <div className="adm-card-body">
              <div className="rm-summary">
                <div className="item">
                  <div className="k">Date</div>
                  <div className="v">{formatRaceDate(race.race_date)}</div>
                </div>
                <div className="item">
                  <div className="k">Jump</div>
                  <div className="v">{formatJumpTime(race.scheduled_at)}</div>
                </div>
                <div className="item">
                  <div className="k">Runners</div>
                  <div className="v">{runners.length}</div>
                </div>
                <div className="item">
                  <div className="k">Source</div>
                  <div className="v">{race.source === "manual" ? "Entered manually" : "Racing API feed"}</div>
                </div>
              </div>
            </div>
          </div>

          {/* Correct ------------------------------------------------- */}
          <div className="adm-card">
            <div className="adm-card-head">
              <div>
                <h2>Correct this race</h2>
                <p className="sub">Edit any field. Runners and results are unaffected.</p>
              </div>
            </div>
            <div className="adm-card-body">
              {isFeedRow ? (
                <div className="rm-notice" style={{ marginBottom: 18 }}>
                  {race.manual_override ? (
                    <>
                      <strong>This feed race is pinned.</strong> It has been corrected by hand, so
                      the Racing API poll no longer overwrites it. Further edits stay put.
                    </>
                  ) : (
                    <>
                      <strong>This race came from the Racing API feed.</strong> Saving a correction
                      pins it — the poll stops touching it and your edit sticks. Deleting it without
                      correcting it first means the next poll may simply re-create it.
                    </>
                  )}
                </div>
              ) : null}

              <form onSubmit={saveCorrection}>
                <div className="field-grid">
                  <div className="field-grid cols-3">
                    <div>
                      <label className="adm-label" htmlFor="e-venue">
                        Venue
                      </label>
                      <input
                        id="e-venue"
                        className="adm-input"
                        value={edit.venue}
                        onChange={(e) => setEdit({ ...edit, venue: e.target.value })}
                      />
                    </div>
                    <div>
                      <label className="adm-label" htmlFor="e-date">
                        Race date
                      </label>
                      <input
                        id="e-date"
                        type="date"
                        className="adm-input"
                        value={edit.raceDate}
                        onChange={(e) => setEdit({ ...edit, raceDate: e.target.value })}
                      />
                    </div>
                    <div>
                      <label className="adm-label" htmlFor="e-number">
                        Race number
                      </label>
                      <input
                        id="e-number"
                        type="number"
                        min={1}
                        className="adm-input"
                        value={edit.raceNumber}
                        onChange={(e) => setEdit({ ...edit, raceNumber: e.target.value })}
                      />
                    </div>
                  </div>
                  <div className="field-grid cols-3">
                    <div>
                      <label className="adm-label" htmlFor="e-class">
                        Class
                      </label>
                      <input
                        id="e-class"
                        className="adm-input"
                        value={edit.raceClass}
                        onChange={(e) => setEdit({ ...edit, raceClass: e.target.value })}
                      />
                    </div>
                    <div>
                      <label className="adm-label" htmlFor="e-distance">
                        Distance (m)
                      </label>
                      <input
                        id="e-distance"
                        type="number"
                        min={0}
                        className="adm-input"
                        value={edit.distanceM}
                        onChange={(e) => setEdit({ ...edit, distanceM: e.target.value })}
                      />
                    </div>
                    <div>
                      <label className="adm-label" htmlFor="e-jump">
                        Jump time
                      </label>
                      <input
                        id="e-jump"
                        type="datetime-local"
                        className="adm-input"
                        value={edit.scheduledAt}
                        onChange={(e) => setEdit({ ...edit, scheduledAt: e.target.value })}
                      />
                    </div>
                  </div>
                </div>
                <div className="form-actions">
                  <button
                    type="submit"
                    className="btn btn-primary"
                    style={{ padding: "10px 22px" }}
                    disabled={busy !== null}
                  >
                    {busy === "correct" ? "Saving…" : "Save correction"}
                  </button>
                </div>
              </form>
            </div>
          </div>

          {/* Runners ------------------------------------------------- */}
          <div className="adm-card">
            <div className="adm-card-head">
              <div>
                <h2>Runners</h2>
                <p className="sub">
                  Attached runners behave exactly like feed runners: the 2h reminder and result
                  pushes fire the same way.
                </p>
              </div>
            </div>

            {runners.length === 0 ? (
              <div className="adm-empty">
                <h3>No runners yet</h3>
                <p>Attach a platform horse to this race to start tracking its run.</p>
              </div>
            ) : (
              <table className="adm-table">
                <thead>
                  <tr>
                    <th>Horse</th>
                    <th className="nowrap">Barrier</th>
                    <th>Jockey</th>
                    <th>Entry</th>
                    <th>Result</th>
                  </tr>
                </thead>
                <tbody>
                  {runners.map((rh) => {
                    const rs = runnerStatusPill(rh.entry_status);
                    const draft = result[rh.id] ?? { result: "", finishPosition: "", prizeCents: "" };
                    const recorded = rh.entry_status === "ran";
                    return (
                      <tr key={rh.id}>
                        <td>
                          <div className="row-name">{horseName(rh.horse)}</div>
                        </td>
                        <td className="nowrap">{rh.barrier ?? "—"}</td>
                        <td>{rh.jockey ?? "—"}</td>
                        <td>
                          <span className={rs.className}>{rs.label}</span>
                        </td>
                        <td>
                          {recorded ? (
                            <>
                              <div className="row-name">{rh.result ?? "—"}</div>
                              {rh.finish_position != null ? (
                                <div className="row-sub">Finished {rh.finish_position}</div>
                              ) : null}
                            </>
                          ) : (
                            <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                              <input
                                className="adm-input"
                                style={{ width: 130 }}
                                placeholder="2nd of 12"
                                aria-label={`Result for ${horseName(rh.horse)}`}
                                value={draft.result}
                                onChange={(e) =>
                                  setResult({ ...result, [rh.id]: { ...draft, result: e.target.value } })
                                }
                              />
                              <input
                                className="adm-input"
                                style={{ width: 74 }}
                                type="number"
                                min={1}
                                placeholder="Pos"
                                aria-label={`Finish position for ${horseName(rh.horse)}`}
                                value={draft.finishPosition}
                                onChange={(e) =>
                                  setResult({
                                    ...result,
                                    [rh.id]: { ...draft, finishPosition: e.target.value },
                                  })
                                }
                              />
                              <input
                                className="adm-input"
                                style={{ width: 110 }}
                                type="number"
                                min={0}
                                placeholder="Prize (c)"
                                aria-label={`Prize money in cents for ${horseName(rh.horse)}`}
                                value={draft.prizeCents}
                                onChange={(e) =>
                                  setResult({
                                    ...result,
                                    [rh.id]: { ...draft, prizeCents: e.target.value },
                                  })
                                }
                              />
                              <button
                                type="button"
                                className="btn btn-primary"
                                style={{ padding: "8px 14px", fontSize: "12.5px" }}
                                onClick={() => recordResult(rh)}
                                disabled={busy !== null || (!draft.result.trim() && !draft.finishPosition)}
                              >
                                {busy === `result-${rh.id}` ? "Saving…" : "Record"}
                              </button>
                            </div>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}

            <div className="adm-card-body" style={{ borderTop: "1px solid var(--line)" }}>
              <form onSubmit={attachRunner}>
                <div className="field-grid cols-3">
                  <div>
                    <label className="adm-label" htmlFor="r-horse">
                      Horse
                    </label>
                    <select
                      id="r-horse"
                      className="adm-input"
                      value={runner.horseId}
                      onChange={(e) => setRunner({ ...runner, horseId: e.target.value })}
                      required
                    >
                      <option value="">Select a horse…</option>
                      {attachable.map((h) => (
                        <option key={h.id} value={h.id}>
                          {h.racing_name ?? h.display_name}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label className="adm-label" htmlFor="r-barrier">
                      Barrier
                    </label>
                    <input
                      id="r-barrier"
                      type="number"
                      min={1}
                      className="adm-input"
                      value={runner.barrier}
                      onChange={(e) => setRunner({ ...runner, barrier: e.target.value })}
                    />
                  </div>
                  <div>
                    <label className="adm-label" htmlFor="r-jockey">
                      Jockey
                    </label>
                    <input
                      id="r-jockey"
                      className="adm-input"
                      placeholder="T. Berry"
                      value={runner.jockey}
                      onChange={(e) => setRunner({ ...runner, jockey: e.target.value })}
                    />
                  </div>
                </div>
                <div className="form-actions">
                  <button
                    type="submit"
                    className="btn btn-primary"
                    style={{ padding: "10px 22px" }}
                    disabled={busy !== null || !runner.horseId}
                  >
                    {busy === "attach" ? "Attaching…" : "Attach runner"}
                  </button>
                </div>
              </form>
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
