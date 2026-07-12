"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { supabaseBrowser } from "@/lib/supabase/client";
import { signPhoto } from "@/lib/storage/photos";
import { TRAINING_STATUSES, dollarsToCents, humanizeTrainingStatus } from "./format";

// Shared add/edit form — screens/07-add-horse.html. In edit mode the same
// layout is reused (there is no separate edit mockup), prefilled and issuing
// PATCH instead of POST. No owner field anywhere (guardrail: no owner PII).

const PHOTO_BUCKET = "horse-photos";

const SEX_OPTIONS = ["gelding", "colt", "filly", "mare", "stallion"] as const;

export type Trainer = { id: string; display_name: string | null; stable_name: string | null };

export type HorseInitial = {
  trainerId?: string;
  stableName?: string;
  racingName?: string;
  foalingYear?: string;
  sex?: string;
  colour?: string;
  sire?: string;
  dam?: string;
  starts?: string;
  wins?: string;
  places?: string;
  prize?: string;
  story?: string;
  photoUrl?: string;
  status?: string; // horse_status: active | disabled
  trainingStatus?: string;
};

type Props = {
  mode: "create" | "edit";
  trainers: Trainer[];
  horseId?: string;
  initial?: HorseInitial;
};

function trainerLabel(t: Trainer): string {
  return t.stable_name ? `${t.display_name} (${t.stable_name})` : (t.display_name ?? "Unnamed trainer");
}

export default function HorseForm({ mode, trainers, horseId, initial = {} }: Props) {
  const router = useRouter();
  const fileRef = useRef<HTMLInputElement>(null);

  const [form, setForm] = useState<Required<HorseInitial>>({
    trainerId: initial.trainerId ?? "",
    stableName: initial.stableName ?? "",
    racingName: initial.racingName ?? "",
    foalingYear: initial.foalingYear ?? "",
    sex: initial.sex ?? "gelding",
    colour: initial.colour ?? "",
    sire: initial.sire ?? "",
    dam: initial.dam ?? "",
    starts: initial.starts ?? "",
    wins: initial.wins ?? "",
    places: initial.places ?? "",
    prize: initial.prize ?? "",
    story: initial.story ?? "",
    photoUrl: initial.photoUrl ?? "",
    status: initial.status ?? "active",
    trainingStatus: initial.trainingStatus ?? "spelling",
  });
  const [submitting, setSubmitting] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // `photoUrl` stores the private-bucket object PATH; sign it for the <img>.
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    if (!initial.photoUrl) return;
    signPhoto(supabaseBrowser(), PHOTO_BUCKET, initial.photoUrl).then((url) => {
      if (active) setPreviewUrl(url);
    });
    return () => {
      active = false;
    };
  }, [initial.photoUrl]);

  const set = <K extends keyof HorseInitial>(key: K, value: string) =>
    setForm((f) => ({ ...f, [key]: value }));

  async function onPickPhoto(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploading(true);
    setError(null);
    try {
      const ext = file.name.split(".").pop() ?? "jpg";
      const path = `${crypto.randomUUID()}.${ext}`;
      const sb = supabaseBrowser();
      const { error: upErr } = await sb.storage.from(PHOTO_BUCKET).upload(path, file, {
        cacheControl: "3600",
        upsert: true,
      });
      if (upErr) throw upErr;
      // Store the object path (private bucket); sign it for the live preview.
      set("photoUrl", path);
      setPreviewUrl(await signPhoto(sb, PHOTO_BUCKET, path));
    } catch {
      setError("Photo upload failed. You can still save and add a photo later.");
    } finally {
      setUploading(false);
    }
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!form.trainerId) {
      setError("Please assign a trainer.");
      return;
    }
    setSubmitting(true);
    try {
      const foalingYear = form.foalingYear ? Number(form.foalingYear) : undefined;
      const stats = {
        starts: Number(form.starts) || 0,
        wins: Number(form.wins) || 0,
        places: Number(form.places) || 0,
        prizeMoneyCents: dollarsToCents(form.prize),
      };
      const attrs = {
        trainerId: form.trainerId,
        sire: form.sire || undefined,
        dam: form.dam || undefined,
        displayName: form.stableName || undefined,
        stableName: form.stableName || undefined,
        racingName: form.racingName || undefined,
        sex: form.sex || undefined,
        colour: form.colour || undefined,
        foalingYear,
        story: form.story || undefined,
        photoUrl: form.photoUrl || undefined,
        status: form.status,
        trainingStatus: form.trainingStatus,
      };

      if (mode === "create") {
        const res = await fetch("/api/admin/horses", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ...attrs, ...stats }),
        });
        if (!res.ok) throw new Error((await res.json())?.error?.message ?? "Create failed");
      } else {
        const res = await fetch(`/api/admin/horses/${horseId}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(attrs),
        });
        if (!res.ok) throw new Error((await res.json())?.error?.message ?? "Update failed");
        const statsRes = await fetch(`/api/admin/horses/${horseId}/stats`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(stats),
        });
        if (!statsRes.ok) throw new Error((await statsRes.json())?.error?.message ?? "Stats update failed");
      }

      router.push("/horses");
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong.");
      setSubmitting(false);
    }
  }

  const heading = mode === "create" ? "Add horse" : "Edit horse";
  const cta = mode === "create" ? "Add to library" : "Save changes";

  return (
    <form onSubmit={onSubmit}>
      <div className="admin-topbar">
        <h1>
          <Link
            href="/horses"
            style={{ color: "var(--muted)", textDecoration: "none", fontWeight: 400, fontSize: 16 }}
          >
            Horses
          </Link>
          <span style={{ color: "var(--muted)", fontWeight: 400, margin: "0 8px" }}>›</span>
          {heading}
        </h1>
        <div className="actions">
          <Link href="/horses" style={{ fontSize: "13.5px", color: "var(--muted)", textDecoration: "none" }}>
            Cancel
          </Link>
          <button type="submit" className="btn btn-primary" style={{ padding: "8px 18px", fontSize: "13.5px" }} disabled={submitting || uploading}>
            {submitting ? "Saving…" : cta}
          </button>
        </div>
      </div>

      <div className="admin-content">
        <div style={{ maxWidth: 760 }}>
          {error && <div className="form-error">{error}</div>}

          {/* Basics */}
          <div className="adm-card" style={{ marginBottom: 22 }}>
            <div className="adm-card-head">
              <div>
                <h2>Basics</h2>
                <div className="sub">Identifying information for the horse.</div>
              </div>
            </div>
            <div className="adm-card-body field-grid">
              <div className="field-grid cols-2">
                <div>
                  <label className="adm-label">Stable name</label>
                  <input
                    className="adm-input"
                    type="text"
                    placeholder="e.g. Mahogany"
                    value={form.stableName}
                    onChange={(e) => set("stableName", e.target.value)}
                  />
                  <div className="adm-help">Shown on profile and feed.</div>
                </div>
                <div>
                  <label className="adm-label">Registered name (Racing Australia)</label>
                  <input
                    className="adm-input"
                    type="text"
                    placeholder="e.g. MAHOGANY (AUS)"
                    value={form.racingName}
                    onChange={(e) => set("racingName", e.target.value)}
                  />
                </div>
              </div>
              <div className="field-grid cols-3">
                <div>
                  <label className="adm-label">Foaling year</label>
                  <input
                    className="adm-input"
                    type="text"
                    inputMode="numeric"
                    placeholder="e.g. 2020"
                    value={form.foalingYear}
                    onChange={(e) => set("foalingYear", e.target.value)}
                  />
                  <div className="adm-help">Age is calculated automatically — every horse turns a year older on 1 August.</div>
                </div>
                <div>
                  <label className="adm-label">Sex</label>
                  <select className="adm-input" value={form.sex} onChange={(e) => set("sex", e.target.value)}>
                    {SEX_OPTIONS.map((s) => (
                      <option key={s} value={s}>
                        {s[0].toUpperCase() + s.slice(1)}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="adm-label">Colour</label>
                  <input
                    className="adm-input"
                    type="text"
                    placeholder="Bay, Chestnut…"
                    value={form.colour}
                    onChange={(e) => set("colour", e.target.value)}
                  />
                </div>
              </div>
              <div className="field-grid cols-2">
                <div>
                  <label className="adm-label">Sire</label>
                  <input
                    className="adm-input"
                    type="text"
                    placeholder="e.g. Snitzel"
                    value={form.sire}
                    onChange={(e) => set("sire", e.target.value)}
                  />
                </div>
                <div>
                  <label className="adm-label">Dam</label>
                  <input
                    className="adm-input"
                    type="text"
                    placeholder="e.g. Polar Success"
                    value={form.dam}
                    onChange={(e) => set("dam", e.target.value)}
                  />
                </div>
              </div>
            </div>
          </div>

          {/* Race record */}
          <div className="adm-card" style={{ marginBottom: 22 }}>
            <div className="adm-card-head">
              <div>
                <h2>Race record</h2>
                <div className="sub">Career stats shown on the horse profile.</div>
              </div>
            </div>
            <div className="adm-card-body field-grid">
              <div className="field-grid cols-4">
                <div>
                  <label className="adm-label">Starts</label>
                  <input className="adm-input" type="text" inputMode="numeric" placeholder="e.g. 24" value={form.starts} onChange={(e) => set("starts", e.target.value)} />
                </div>
                <div>
                  <label className="adm-label">Wins</label>
                  <input className="adm-input" type="text" inputMode="numeric" placeholder="e.g. 6" value={form.wins} onChange={(e) => set("wins", e.target.value)} />
                </div>
                <div>
                  <label className="adm-label">Places</label>
                  <input className="adm-input" type="text" inputMode="numeric" placeholder="e.g. 9" value={form.places} onChange={(e) => set("places", e.target.value)} />
                </div>
                <div>
                  <label className="adm-label">Prize money</label>
                  <input className="adm-input" type="text" placeholder="e.g. $1.2M" value={form.prize} onChange={(e) => set("prize", e.target.value)} />
                </div>
              </div>
              <div className="adm-help">Updated manually.</div>
            </div>
          </div>

          {/* Trainer */}
          <div className="adm-card" style={{ marginBottom: 22 }}>
            <div className="adm-card-head">
              <div>
                <h2>Trainer</h2>
                <div className="sub">Who&apos;s training this horse.</div>
              </div>
            </div>
            <div className="adm-card-body field-grid">
              <div>
                <label className="adm-label">Assigned trainer</label>
                <select
                  className="adm-input"
                  value={form.trainerId}
                  onChange={(e) => set("trainerId", e.target.value)}
                  disabled={mode === "edit"}
                >
                  <option value="">Select a trainer</option>
                  {trainers.map((t) => (
                    <option key={t.id} value={t.id}>
                      {trainerLabel(t)}
                    </option>
                  ))}
                </select>
                <div className="adm-help">
                  {mode === "edit" ? (
                    "Trainer is fixed once a horse is created."
                  ) : (
                    <>
                      Don&apos;t see them?{" "}
                      <Link href="/trainers/new" style={{ color: "var(--brand-green)", textDecoration: "none", fontWeight: 500 }}>
                        Add a new trainer
                      </Link>
                    </>
                  )}
                </div>
              </div>
            </div>
          </div>

          {/* Profile photo */}
          <div className="adm-card" style={{ marginBottom: 22 }}>
            <div className="adm-card-head">
              <div>
                <h2>Profile photo</h2>
                <div className="sub">Cover image shown on the horse&apos;s profile (16:9 recommended).</div>
              </div>
            </div>
            <div className="adm-card-body">
              <div className={form.photoUrl ? "upload-zone filled" : "upload-zone"} style={form.photoUrl ? undefined : { padding: 28 }}>
                {form.photoUrl ? (
                  <>
                    <div className="preview">
                      {/* eslint-disable-next-line @next/next/no-img-element -- signed Storage preview */}
                      <img src={previewUrl ?? undefined} alt="Horse cover preview" />
                    </div>
                    <div className="upload-tools">
                      <div className="upload-meta">Photo uploaded</div>
                      <button type="button" className="btn btn-light" style={{ padding: "6px 12px", fontSize: "12.5px" }} onClick={() => fileRef.current?.click()}>
                        Replace
                      </button>
                    </div>
                  </>
                ) : (
                  <>
                    <div style={{ fontWeight: 500, fontSize: 14 }}>
                      {uploading ? "Uploading…" : (
                        <>
                          Drop image here or{" "}
                          <span className="browse" onClick={() => fileRef.current?.click()}>
                            browse
                          </span>
                        </>
                      )}
                    </div>
                    <div className="adm-help" style={{ marginTop: 6 }}>JPEG or PNG · up to 5 MB · ideally 1600×900</div>
                  </>
                )}
                <input ref={fileRef} type="file" accept="image/png,image/jpeg" onChange={onPickPhoto} />
              </div>
            </div>
          </div>

          {/* Bio */}
          <div className="adm-card" style={{ marginBottom: 22 }}>
            <div className="adm-card-head">
              <div>
                <h2>Bio</h2>
                <div className="sub">A short description for the profile page.</div>
              </div>
            </div>
            <div className="adm-card-body">
              <textarea
                className="adm-input"
                placeholder="A couple of sentences on background, pedigree, or notable wins…"
                value={form.story}
                onChange={(e) => set("story", e.target.value)}
              />
            </div>
          </div>

          {/* Status & visibility */}
          <div className="adm-card">
            <div className="adm-card-head">
              <div>
                <h2>Status &amp; visibility</h2>
                <div className="sub">Whether members can find and follow this horse.</div>
              </div>
            </div>
            <div className="adm-card-body field-grid">
              <div>
                <label className="adm-label">Current status</label>
                <select className="adm-input" value={form.trainingStatus} onChange={(e) => set("trainingStatus", e.target.value)}>
                  {TRAINING_STATUSES.map((s) => (
                    <option key={s} value={s}>
                      {humanizeTrainingStatus(s)}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="adm-label">Visibility</label>
                <select className="adm-input" value={form.status} onChange={(e) => set("status", e.target.value)}>
                  <option value="active">Visible to members</option>
                  <option value="disabled">Hidden (admin-only preview)</option>
                </select>
                <div className="adm-help">Hidden horses don&apos;t appear in browse or search. Useful for setting up before announcing.</div>
              </div>
            </div>
          </div>

          <div className="form-actions">
            <Link href="/horses" className="btn btn-light" style={{ padding: "10px 22px" }}>
              Cancel
            </Link>
            <button type="submit" className="btn btn-primary" style={{ padding: "10px 22px" }} disabled={submitting || uploading}>
              {submitting ? "Saving…" : cta}
            </button>
          </div>
        </div>
      </div>
    </form>
  );
}
