"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { supabaseBrowser } from "@/lib/supabase/client";
import { signPhoto } from "@/lib/storage/photos";
import { SHARES_WEBSITE_REQUIRED } from "@/lib/horses/shares-for-sale";
import { trainerHasWebsite } from "@/lib/trainers/website-url";
import PhotoCropField, { type PickedPhoto } from "../components/PhotoCropField";
import { HORSE_SEXES, TRAINING_STATUSES, dollarsToCents, horseSexLabel, humanizeTrainingStatus } from "./format";

// Shared add/edit form — screens/07-add-horse.html (re-cut 18 Aug 2026). In
// edit mode the same layout is reused (there is no separate edit mockup),
// prefilled and issuing PATCH instead of POST. No owner field anywhere
// (guardrail: no owner PII).
//
// Sex is now the horse's SEX (male|female) plus a separate Gelded flag. It used
// to be a five-item select of race-day DESCRIPTIONS — Gelding / Colt / Filly /
// Mare / Stallion — which is why a filly stayed a filly at eight: nothing ever
// changed it. The description now derives in Postgres from sex + age + gelded:
//
//   filly   female, under 4        mare   female, 4 and over
//   colt    entire male, under 4   horse  entire male, 4 and over
//   gelding a gelded male, ANY age
//
// `Stallion` is dropped — it is not a race-day description in Australia.
//
// ENG-829: "Shares for sale" is a boolean toggle gated on the selected
// trainer's website_url (the public Shares CTA target). No price / owner /
// vendor fields. Mockup 07-add-horse.html has no toggle — needs-design-check;
// control matches the existing Gelded / Status form patterns.

const PHOTO_BUCKET = "horse-photos";

export type Trainer = {
  id: string;
  display_name: string | null;
  stable_name: string | null;
  /** Public CTA target for Shares; null/absent → for-sale toggle disabled. */
  website_url?: string | null;
};

export type HorseInitial = {
  trainerId?: string;
  stableName?: string;
  racingName?: string;
  foalingYear?: string;
  // "" means NO SELECTION. A row whose `sex` is NULL (a legacy description the
  // migration could not map) must stay unselected — defaulting it to a sex is
  // exactly the guess this epic removes.
  sex?: string;
  isGelded?: boolean;
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
  /** ENG-829 — horse.shares_for_sale */
  sharesForSale?: boolean;
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

  const [form, setForm] = useState({
    trainerId: initial.trainerId ?? "",
    stableName: initial.stableName ?? "",
    racingName: initial.racingName ?? "",
    foalingYear: initial.foalingYear ?? "",
    // No default. An unset sex stays unset — the old form defaulted to
    // "gelding", which is how a stable full of wrongly-described horses got in.
    sex: initial.sex ?? "",
    isGelded: initial.isGelded ?? false,
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
    sharesForSale: initial.sharesForSale ?? false,
  });
  const [submitting, setSubmitting] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // `photoUrl` stores the private-bucket object PATH; sign it for the <img>.
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  // ENG-749. The picked file awaiting its crop; nothing uploads until it resolves.
  const [pendingPhoto, setPendingPhoto] = useState<File | null>(null);
  // Justin, 26 Aug: re-open the crop dialog on the ALREADY-uploaded photo so the
  // admin can reposition it without re-picking a file.
  const [preparingReposition, setPreparingReposition] = useState(false);

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

  // Only the free-text/select fields; booleans have their own handlers below.
  type StringField = {
    [K in keyof HorseInitial]-?: HorseInitial[K] extends string | undefined ? K : never;
  }[keyof HorseInitial];

  const set = (key: StringField, value: string) => setForm((f) => ({ ...f, [key]: value }));

  // Selecting Female CLEARS isGelded in the SAME state update — disabling the
  // checkbox alone would leave a stale `true` in state, and the database CHECK
  // (`not is_gelded or sex is not distinct from 'male'`) would reject the submit
  // with a raw 23514. Clearing on "no selection" too, for the same reason.
  const setSex = (value: string) =>
    setForm((f) => ({ ...f, sex: value, isGelded: value === "male" ? f.isGelded : false }));

  const setGelded = (value: boolean) => setForm((f) => ({ ...f, isGelded: value }));

  const selectedTrainer = trainers.find((t) => t.id === form.trainerId);
  const canSellShares = trainerHasWebsite(selectedTrainer?.website_url);

  // Create mode: switching trainers must drop a stale for-sale flag when the
  // new trainer has no website (the toggle alone being disabled is not enough —
  // a checked+disabled checkbox would still submit true).
  const setTrainerId = (value: string) => {
    const next = trainers.find((t) => t.id === value);
    const ok = trainerHasWebsite(next?.website_url);
    setForm((f) => ({
      ...f,
      trainerId: value,
      sharesForSale: ok ? f.sharesForSale : false,
    }));
  };

  const setSharesForSale = (value: boolean) => {
    if (value && !canSellShares) return;
    setForm((f) => ({ ...f, sharesForSale: value }));
  };

  // ENG-749. Picking opens the crop step rather than uploading; the input is
  // reset so re-picking the same file after a cancel still fires a change.
  function onPickPhoto(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    setError(null);
    setPendingPhoto(file);
  }

  // ENG-749. `picked.ext` describes the BYTES, not the picked file — a PNG
  // cropped to JPEG must land on a .jpg key. Use-as-is passes the original file
  // and its original extension through unchanged.
  async function uploadPhoto(picked: PickedPhoto) {
    setPendingPhoto(null);
    setUploading(true);
    setError(null);
    try {
      const path = `${crypto.randomUUID()}.${picked.ext}`;
      const sb = supabaseBrowser();
      const { error: upErr } = await sb.storage.from(PHOTO_BUCKET).upload(path, picked.blob, {
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

  // Justin, 26 Aug: reposition an already-uploaded photo. Pull the stored image
  // back down and feed it to the SAME crop dialog. Note it re-crops what was
  // saved: a photo stored "use as-is" re-crops fully; one already cropped can
  // only be repositioned within the saved square, not have trimmed edges back.
  async function repositionExisting() {
    if (!previewUrl) return;
    setError(null);
    setPreparingReposition(true);
    try {
      const res = await fetch(previewUrl);
      if (!res.ok) throw new Error(`fetch ${res.status}`);
      const blob = await res.blob();
      const type = blob.type || "image/jpeg";
      const ext = type.includes("png") ? "png" : "jpg";
      setPendingPhoto(new File([blob], `reposition.${ext}`, { type }));
    } catch {
      setError("Couldn't load the photo to reposition. Use Replace to pick it again.");
    } finally {
      setPreparingReposition(false);
    }
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!form.trainerId) {
      setError("Please assign a trainer.");
      return;
    }
    if (form.sharesForSale && !canSellShares) {
      setError(SHARES_WEBSITE_REQUIRED);
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
        isGelded: form.isGelded,
        colour: form.colour || undefined,
        foalingYear,
        story: form.story || undefined,
        photoUrl: form.photoUrl || undefined,
        status: form.status,
        trainingStatus: form.trainingStatus,
        sharesForSale: form.sharesForSale,
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

      {/* `horse-form` scopes this screen's responsive rules in horses.css (the
          mockup classes it reflows are duplicated in trainers.css, which this
          ticket must not touch). `horse-form-body` carries the clearance for
          the fixed mobile save bar. ENG-247. */}
      <div className="admin-content horse-form">
        <div className="horse-form-body" style={{ maxWidth: 760 }}>
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
                  <label className="adm-label" htmlFor="horse-sex">
                    Sex
                  </label>
                  {/* Exactly two SELECTABLE options, Male and Female.
                      The disabled placeholder is not a third choice — it is the
                      only way to render "no sex on record" honestly. With two
                      bare options and value="", HTML's own reset rule ("if no
                      option is selected, select the first non-disabled one")
                      silently selects MALE, which is precisely the defaulting
                      this ticket removes. `disabled` keeps it out of the reset
                      and out of reach once a sex has been stated. */}
                  <select
                    id="horse-sex"
                    className="adm-input"
                    value={form.sex}
                    onChange={(e) => setSex(e.target.value)}
                  >
                    <option value="" disabled hidden>
                      Select a sex
                    </option>
                    {HORSE_SEXES.map((s) => (
                      <option key={s} value={s}>
                        {horseSexLabel(s)}
                      </option>
                    ))}
                  </select>
                  <label
                    htmlFor="horse-gelded"
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 8,
                      marginTop: 8,
                      fontSize: 13,
                      cursor: form.sex === "male" ? "pointer" : "not-allowed",
                      opacity: form.sex === "male" ? 1 : 0.6,
                    }}
                  >
                    <input
                      id="horse-gelded"
                      type="checkbox"
                      style={{ accentColor: "var(--brand-green)" }}
                      checked={form.isGelded}
                      disabled={form.sex !== "male"}
                      onChange={(e) => setGelded(e.target.checked)}
                    />
                    Gelded
                  </label>
                  <div className="adm-help">Shows as &ldquo;gelding&rdquo; at any age, overriding colt or horse.</div>
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
                  onChange={(e) => setTrainerId(e.target.value)}
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
                {/* Justin, 26 Aug: preview BOTH surfaces — the wide profile
                    banner (mobile & web) and the square list thumbnail — so the
                    admin sees exactly how the crop lands on each. */}
                <div className="sub">Shown as the banner on the horse&apos;s profile (mobile &amp; web) and as a square in horse lists.</div>
              </div>
            </div>
            <div className="adm-card-body">
              {/* The empty-zone `padding: 28` moved to horses.css
                  (`.horse-form .upload-zone:not(.filled)`) — same desktop
                  value, but now overridable at the mobile breakpoint. */}
              <div className={form.photoUrl ? "upload-zone filled" : "upload-zone"}>
                {form.photoUrl ? (
                  <>
                    <div className="preview-set">
                      <figure className="preview-banner" data-testid="horse-preview-banner">
                        {/* eslint-disable-next-line @next/next/no-img-element -- signed Storage preview */}
                        <img src={previewUrl ?? undefined} alt="Horse profile banner preview" />
                        <figcaption>Profile banner — mobile &amp; web</figcaption>
                      </figure>
                      <figure className="preview-square" data-testid="horse-preview-square">
                        {/* eslint-disable-next-line @next/next/no-img-element -- signed Storage preview */}
                        <img src={previewUrl ?? undefined} alt="Horse list thumbnail preview" />
                        <figcaption>In lists</figcaption>
                      </figure>
                    </div>
                    <div className="upload-tools">
                      <div className="upload-meta">Photo uploaded</div>
                      <button
                        type="button"
                        className="btn btn-light"
                        style={{ padding: "6px 12px", fontSize: "12.5px" }}
                        onClick={repositionExisting}
                        disabled={preparingReposition || uploading}
                        data-testid="horse-photo-reposition"
                      >
                        {preparingReposition ? "Loading…" : "Reposition"}
                      </button>
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
                    <div className="adm-help" style={{ marginTop: 6 }}>JPEG or PNG · up to 5 MB · ideally 1200×1200</div>
                  </>
                )}
                <input ref={fileRef} type="file" accept="image/png,image/jpeg" onChange={onPickPhoto} />
                {pendingPhoto ? (
                  <PhotoCropField
                    file={pendingPhoto}
                    subject="horse"
                    onCancel={() => setPendingPhoto(null)}
                    onApply={uploadPhoto}
                  />
                ) : null}
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
              <label
                className="adm-check"
                htmlFor="shares-for-sale"
                style={{ cursor: canSellShares ? "pointer" : "not-allowed", opacity: canSellShares ? 1 : 0.75 }}
              >
                <input
                  id="shares-for-sale"
                  type="checkbox"
                  checked={form.sharesForSale}
                  disabled={!canSellShares}
                  onChange={(e) => setSharesForSale(e.target.checked)}
                  data-testid="shares-for-sale"
                />
                <span>
                  <span className="adm-check-title">Shares for sale</span>
                  <span className="adm-help">
                    Lists this horse on the member Shares tab. Contact goes to the trainer&apos;s website.
                  </span>
                </span>
              </label>
              {!canSellShares && form.trainerId ? (
                <div className="adm-help adm-check-note" data-testid="shares-website-required">
                  {SHARES_WEBSITE_REQUIRED}
                </div>
              ) : null}
            </div>
          </div>

          {/* Below 720px horses.css turns this row into the epic's fixed
              bottom save bar (rule 7). The inline paddings are dropped so the
              mobile rule can size the two buttons to the 44px tap target;
              `.horse-form-actions .btn` in horses.css keeps the desktop
              10px/22px. */}
          <div className="form-actions horse-form-actions" data-testid="horse-form-actions">
            <Link href="/horses" className="btn btn-light">
              Cancel
            </Link>
            <button type="submit" className="btn btn-primary" disabled={submitting || uploading}>
              {submitting ? "Saving…" : cta}
            </button>
          </div>
        </div>
      </div>
    </form>
  );
}
