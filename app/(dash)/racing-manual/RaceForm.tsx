"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";

// Create a race the feed doesn't have (RF6 / ENG-180). Venue + date + number are the
// natural key: the server rejects a duplicate with 409 rather than creating a second
// row for one real race, so this form surfaces that as a plain-language conflict.

type Form = {
  venue: string;
  raceDate: string;
  raceNumber: string;
  raceClass: string;
  distanceM: string;
  scheduledAt: string;
};

const EMPTY: Form = {
  venue: "",
  raceDate: "",
  raceNumber: "",
  raceClass: "",
  distanceM: "",
  scheduledAt: "",
};

export default function RaceForm() {
  const router = useRouter();
  const [form, setForm] = useState<Form>(EMPTY);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const set = (key: keyof Form, value: string) => setForm((f) => ({ ...f, [key]: value }));

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const res = await fetch("/api/admin/races", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          venue: form.venue.trim(),
          raceDate: form.raceDate,
          raceNumber: form.raceNumber,
          raceClass: form.raceClass.trim() || null,
          distanceM: form.distanceM || null,
          scheduledAt: form.scheduledAt ? new Date(form.scheduledAt).toISOString() : null,
        }),
      });
      const json = await res.json().catch(() => null);
      if (!res.ok) throw new Error(json?.error?.message ?? "Could not create the race.");
      router.push(`/racing-manual/${json.data.id}`);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not create the race.");
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={onSubmit}>
      <div className="admin-topbar">
        <h1>
          <Link href="/racing-manual" style={{ color: "inherit", textDecoration: "none" }}>
            Manual races
          </Link>{" "}
          / New race
        </h1>
        <div className="actions">
          <Link href="/racing-manual" className="btn btn-light" style={{ padding: "8px 16px", fontSize: "13.5px" }}>
            Cancel
          </Link>
          <button
            type="submit"
            className="btn btn-primary"
            style={{ padding: "8px 16px", fontSize: "13.5px" }}
            disabled={submitting}
          >
            {submitting ? "Saving…" : "Create race"}
          </button>
        </div>
      </div>

      <div className="admin-content">
        <div className="rm-form-wrap">
          {error ? <div className="form-error" role="alert">{error}</div> : null}

          <div className="adm-card">
            <div className="adm-card-head">
              <div>
                <h2>Race details</h2>
                <p className="sub">Recorded as a manual entry. The feed will not overwrite it.</p>
              </div>
            </div>
            <div className="adm-card-body">
              <div className="field-grid">
                <div className="field-grid cols-3">
                  <div>
                    <label className="adm-label" htmlFor="venue">
                      Venue
                    </label>
                    <input
                      id="venue"
                      className="adm-input"
                      value={form.venue}
                      onChange={(e) => set("venue", e.target.value)}
                      placeholder="Randwick"
                      required
                    />
                  </div>
                  <div>
                    <label className="adm-label" htmlFor="raceDate">
                      Race date
                    </label>
                    <input
                      id="raceDate"
                      type="date"
                      className="adm-input"
                      value={form.raceDate}
                      onChange={(e) => set("raceDate", e.target.value)}
                      required
                    />
                  </div>
                  <div>
                    <label className="adm-label" htmlFor="raceNumber">
                      Race number
                    </label>
                    <input
                      id="raceNumber"
                      type="number"
                      min={1}
                      className="adm-input"
                      value={form.raceNumber}
                      onChange={(e) => set("raceNumber", e.target.value)}
                      placeholder="5"
                      required
                    />
                  </div>
                </div>
                <p className="adm-help" style={{ marginTop: 0 }}>
                  Venue, date and race number together identify the race. If the feed already has
                  it, this will be rejected instead of creating a duplicate.
                </p>

                <div className="field-grid cols-3">
                  <div>
                    <label className="adm-label" htmlFor="raceClass">
                      Class
                    </label>
                    <input
                      id="raceClass"
                      className="adm-input"
                      value={form.raceClass}
                      onChange={(e) => set("raceClass", e.target.value)}
                      placeholder="Maiden, BM78, G2"
                    />
                  </div>
                  <div>
                    <label className="adm-label" htmlFor="distanceM">
                      Distance (m)
                    </label>
                    <input
                      id="distanceM"
                      type="number"
                      min={0}
                      className="adm-input"
                      value={form.distanceM}
                      onChange={(e) => set("distanceM", e.target.value)}
                      placeholder="1400"
                    />
                  </div>
                  <div>
                    <label className="adm-label" htmlFor="scheduledAt">
                      Jump time
                    </label>
                    <input
                      id="scheduledAt"
                      type="datetime-local"
                      className="adm-input"
                      value={form.scheduledAt}
                      onChange={(e) => set("scheduledAt", e.target.value)}
                    />
                    <p className="adm-help">Drives the 2h race-day reminder.</p>
                  </div>
                </div>
              </div>
            </div>
          </div>

          <div className="form-actions">
            <Link href="/racing-manual" className="btn btn-light" style={{ padding: "10px 22px" }}>
              Cancel
            </Link>
            <button
              type="submit"
              className="btn btn-primary"
              style={{ padding: "10px 22px" }}
              disabled={submitting}
            >
              {submitting ? "Saving…" : "Create race"}
            </button>
          </div>
        </div>
      </div>
    </form>
  );
}
