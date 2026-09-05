"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { supabaseBrowser } from "@/lib/supabase/client";
import { signPhoto } from "@/lib/storage/photos";
import { parseWebsiteUrl } from "@/lib/trainers/website-url";
import { slugCollisionMessage } from "@/lib/trainers/slug-collision";
import PhotoCropField, { type CropState, type PickedPhoto } from "../components/PhotoCropField";
import ToastRegion, { saveToastHoldMs, useToast } from "../Toast";
import { publishMarketingPhoto, unpublishMarketingPhoto } from "./marketingPhoto";

// Add / edit trainer form — matches mockups/web/admin/screens/08-add-trainer.html.
// Shared by /trainers/new (create) and /trainers/:id/edit (edit). Contacts are
// internal, admin-only records; the photo uploads direct to the private
// `trainer-photos` bucket (client SDK) and only the resulting path is stored.

const PHOTO_BUCKET = "trainer-photos";

export type ContactInput = { id?: string; role: string; name: string; email: string; phone: string };

export type TrainerData = {
  id: string;
  name: string;
  displayName: string;
  stableName: string;
  location: string;
  bio: string;
  photoUrl: string | null;
  status: "active" | "onboarding";
  marketingVisible: boolean;
  marketingPhotoPath: string | null;
  /**
   * ENG-746. REQUIRED, not optional, on purpose: every caller that builds a
   * seed must decide what to pass. An optional field here would let the edit
   * page drop `website_url` from its `select(...)` and still typecheck, and the
   * form would then silently blank a saved website on the next save.
   */
  websiteUrl: string | null;
};

type Props =
  | { mode: "create" }
  | { mode: "edit"; trainer: TrainerData; contacts: ContactInput[] };

function slugify(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function emptyContact(role = ""): ContactInput {
  return { role, name: "", email: "", phone: "" };
}

// The envelope's error code AND message, read in ONE pass. A Response body can
// only be consumed once, so the create path cannot check the code and then call
// readError() for the text - it has to get both together.
async function readErrorBody(res: Response): Promise<{ code: string | null; message: string }> {
  try {
    const j = await res.json();
    return {
      code: j?.error?.code ?? null,
      message: j?.error?.message ?? `Request failed (${res.status}).`,
    };
  } catch {
    return { code: null, message: `Request failed (${res.status}).` };
  }
}

async function readError(res: Response): Promise<string> {
  return (await readErrorBody(res)).message;
}

export default function TrainerForm(props: Props) {
  const router = useRouter();
  const isEdit = props.mode === "edit";
  const seed = isEdit ? props.trainer : null;

  const [name, setName] = useState(seed?.name ?? "");
  const [displayName, setDisplayName] = useState(seed?.displayName ?? "");
  const [stableName, setStableName] = useState(seed?.stableName ?? "");
  const [location, setLocation] = useState(seed?.location ?? "");
  const [bio, setBio] = useState(seed?.bio ?? "");
  // ENG-746. Held as a STRING (never null) so the input stays controlled; the
  // empty string is converted back to NULL at save time by parseWebsiteUrl.
  const [websiteUrl, setWebsiteUrl] = useState(seed?.websiteUrl ?? "");
  const [photoUrl, setPhotoUrl] = useState<string | null>(seed?.photoUrl ?? null);
  // `photoUrl` holds the private-bucket object PATH; sign it for the <img>.
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [contacts, setContacts] = useState<ContactInput[]>(
    isEdit && props.contacts.length ? props.contacts : [emptyContact("Trainer")],
  );
  const [removed, setRemoved] = useState<string[]>([]);
  const [uploading, setUploading] = useState(false);
  const { toasts, showToast, dismissToast } = useToast();
  // Deferred so the success toast is on screen before the list replaces the
  // form; cleared on unmount so a manual navigation mid-hold cannot fire a
  // stray push afterwards.
  const navTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (navTimer.current) clearTimeout(navTimer.current);
    },
    [],
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  // ENG-749. The picked file awaiting its crop. Non-null mounts the crop step;
  // nothing is uploaded until it resolves one way or the other.
  const [pendingPhoto, setPendingPhoto] = useState<File | null>(null);
  // ENG-980. The source behind the photo that is CURRENTLY STORED, plus the
  // framing last applied to it. Apply used to be a one-way door: it uploaded a
  // square, and "Reposition" then re-opened that SQUARE — which fills the frame
  // exactly at its own floor, so dragging it did nothing and Mel reported the
  // photo as stuck. Re-opening this instead keeps the crop as movable as it was
  // the first time, and repeated Applies re-crop the same source rather than
  // cropping a crop (which permanently ate the edges).
  //
  // Set ONLY once an upload has SUCCEEDED, never at pick time. It is the answer
  // to "what is on screen right now", so a pick that was cancelled — or one
  // whose upload failed — must not land here: "Reposition" would then silently
  // swap the stored photo for a file the admin had backed out of.
  const [sessionPick, setSessionPick] = useState<{ file: File; crop: CropState | null } | null>(
    null,
  );

  // Justin, 26 Aug: reposition the already-uploaded photo without re-picking.
  const [preparingReposition, setPreparingReposition] = useState(false);

  // Marketing-site publication (ENG-766). `marketingPhotoPath` is the object
  // currently living in the PUBLIC bucket; `publishWarning` carries a failed
  // photo copy, which never blocks the profile save. `savedId` is the trainer
  // the copy applies to, so a retry after a failed create re-copies rather than
  // creating a second trainer.
  const [marketingVisible, setMarketingVisible] = useState(seed?.marketingVisible ?? false);
  const [marketingPhotoPath, setMarketingPhotoPath] = useState<string | null>(
    seed?.marketingPhotoPath ?? null,
  );
  const [publishWarning, setPublishWarning] = useState<string | null>(null);
  const [publishing, setPublishing] = useState(false);
  const [savedId, setSavedId] = useState<string | null>(seed?.id ?? null);

  // ENG-746. Whether the Website field still holds exactly what was loaded.
  const websiteUntouched = websiteUrl === (seed?.websiteUrl ?? "");
  // A pre-existing stored value this form cannot parse (see onSubmit for why it
  // does not block the save). Surfaced inline rather than silently tolerated:
  // the app is not rendering that link, and the admin is the only one who can
  // tell whether it is worth fixing.
  const websiteLegacyInvalid =
    websiteUntouched && websiteUrl.trim() !== "" && !parseWebsiteUrl(websiteUrl).ok;

  useEffect(() => {
    const stored = seed?.photoUrl;
    if (!stored) return;
    let active = true;
    signPhoto(supabaseBrowser(), PHOTO_BUCKET, stored).then((url) => {
      if (active) setPreviewUrl(url);
    });
    return () => {
      active = false;
    };
  }, [seed]);

  function setContact(i: number, patch: Partial<ContactInput>) {
    setContacts((cs) => cs.map((c, idx) => (idx === i ? { ...c, ...patch } : c)));
  }
  function addContact() {
    setContacts((cs) => [...cs, emptyContact()]);
  }
  function removeContact(i: number) {
    setContacts((cs) => {
      const c = cs[i];
      if (c.id) setRemoved((r) => [...r, c.id!]);
      return cs.filter((_, idx) => idx !== i);
    });
  }

  // ENG-749. Picking a file no longer uploads it: it opens the crop step, which
  // hands back the bytes to store. The input is reset so re-picking the SAME
  // file still fires a change event (an admin who cancels the crop and changes
  // their mind would otherwise be stuck).
  function onPhoto(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    setError(null);
    setPendingPhoto(file);
  }

  // ENG-749. `picked.ext` describes the BYTES, not the file the admin chose: a
  // PNG cropped to JPEG must land on a .jpg key, because ENG-766's marketing
  // copy derives the public object's key and content type from this extension.
  // A .png key holding JPEG bytes would publish a mislabelled object to the
  // public origin. Use-as-is passes the original file and its original
  // extension straight through, so that path is byte-for-byte what it was.
  async function uploadPhoto(picked: PickedPhoto) {
    // Captured before the dialog closes: this is the file the crop came from,
    // and it becomes the session source only if the upload actually lands.
    const source = pendingPhoto;
    setPendingPhoto(null);
    setError(null);
    setUploading(true);
    try {
      const path = `${slugify(name || "trainer")}-${Date.now()}.${picked.ext}`;
      const sb = supabaseBrowser();
      const { error: upErr } = await sb.storage
        .from(PHOTO_BUCKET)
        .upload(path, picked.blob, { upsert: true });
      if (upErr) {
        setError(`Photo upload failed: ${upErr.message}`);
      } else {
        // Store the object path (private bucket); sign it for the live preview.
        setPhotoUrl(path);
        setPreviewUrl(await signPhoto(sb, PHOTO_BUCKET, path));
        // The upload landed, so THIS is now the stored photo's source. Set only
        // here: a cancelled pick or a failed upload must leave the previous one
        // in place, or "Reposition" would open a photo that was never saved.
        setSessionPick(source ? { file: source, crop: picked.crop ?? null } : null);
      }
    } catch {
      setError("Photo upload failed. You can add it later.");
    } finally {
      setUploading(false);
    }
  }

  async function saveContacts(trainerId: string) {
    for (const id of removed) {
      await fetch(`/api/admin/contacts/${id}`, { method: "DELETE" });
    }
    for (const c of contacts) {
      const hasContent = c.role.trim() && c.name.trim();
      if (c.id) {
        await fetch(`/api/admin/contacts/${c.id}`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ role: c.role, name: c.name, email: c.email || null, phone: c.phone || null }),
        });
      } else if (hasContent) {
        await fetch(`/api/admin/trainers/${trainerId}/contacts`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ role: c.role, name: c.name, email: c.email || null, phone: c.phone || null }),
        });
      }
    }
  }

  // Copy the photo into (or delete it from) the PUBLIC marketing bucket, then
  // record the resulting path. Deliberately runs AFTER the profile save and can
  // never fail it: a broken copy leaves marketing_visible written, the path null
  // and a retryable warning on screen, and the site falls back to the initials
  // disc (W7 contract). Returns whether the caller may navigate away.
  async function syncMarketingPhoto(trainerId: string): Promise<boolean> {
    setPublishing(true);
    try {
      const sb = supabaseBrowser();
      const result = marketingVisible
        ? await publishMarketingPhoto(sb, trainerId, photoUrl, marketingPhotoPath)
        : await unpublishMarketingPhoto(sb, trainerId, marketingPhotoPath);

      if (result.path !== marketingPhotoPath) {
        const res = await fetch(`/api/admin/trainers/${trainerId}`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ marketingPhotoPath: result.path }),
        });
        if (!res.ok) {
          // The object is live but the DB never learned its path. Keep the
          // warning so the admin retries; the retry re-uploads and re-sweeps,
          // and an un-publish sweeps by trainer id regardless of what is stored.
          setPublishWarning(await readError(res));
          return false;
        }
      }
      setMarketingPhotoPath(result.path);
      if (!result.ok) {
        setPublishWarning(result.message);
        return false;
      }
      setPublishWarning(null);
      return true;
    } finally {
      setPublishing(false);
    }
  }

  // The retry only re-runs the copy against the already-saved trainer — it never
  // re-submits the profile, so retrying after a create cannot duplicate a trainer.
  async function retryPublish() {
    if (!savedId) return;
    if (await syncMarketingPhoto(savedId)) {
      showToast("Marketing photo published.", "success");
      navTimer.current = setTimeout(() => {
        router.push("/trainers");
        router.refresh();
      }, saveToastHoldMs());
    }
  }

  // Justin, 26 Aug: reposition an already-uploaded photo through the same crop
  // dialog. ENG-980 split this in two: within the session the original pick is
  // still in memory and is what re-opens, so the full photo is back. Only a
  // photo uploaded in an EARLIER session falls through to the stored object,
  // which re-crops what was saved — trimmed edges do not come back that way.
  async function repositionExisting() {
    if (!previewUrl) return;
    // Re-open the ORIGINAL pick when there is one, so the full photo is back on
    // the table rather than the square that was uploaded from it. Falls through
    // to the stored object only for a photo saved before this form was opened.
    if (sessionPick) {
      setError(null);
      setPendingPhoto(sessionPick.file);
      return;
    }

    setError(null);
    setPreparingReposition(true);
    try {
      const res = await fetch(previewUrl);
      if (!res.ok) throw new Error(`fetch ${res.status}`);
      const blob = await res.blob();
      const type = blob.type || "image/jpeg";
      const ext = type.includes("png") ? "png" : "jpg";
      const restored = new File([blob], `reposition.${ext}`, { type });
      setPendingPhoto(restored);
      // Adopt it as the session's source too, so a SECOND reposition re-opens
      // this same decoded file rather than fetching back the square this one is
      // about to produce. Without it, every cycle cropped the previous crop.
      setSessionPick({ file: restored, crop: null });
    } catch {
      setError("Couldn't load the photo to reposition. Use Replace to pick it again.");
    } finally {
      setPreparingReposition(false);
    }
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setPublishWarning(null);
    if (!name.trim()) {
      setError("Full name is required.");
      return;
    }
    // ENG-746. Validated with the SAME function both routes use, so the form can
    // never send a value the server will reject, and never rejects one it would
    // have accepted. Checked before `setSaving(true)` so a bad URL costs nothing.
    //
    // The `websiteUntouched` escape hatch matters: `trainer.website_url` is an
    // unconstrained text column that no admin surface has ever written, so a row
    // populated by hand can hold something this form rejects (stablepass-web's
    // own code explicitly anticipates a bare domain there). Blocking on it would
    // put a red banner about the Website field in front of an admin who came to
    // fix a typo in the bio, and leave them no way to save at all. An untouched
    // bad value is therefore left exactly as it is: not re-validated, and omitted
    // from the payload below so it is not rewritten either. Touching the field
    // opts back into validation.
    const website = parseWebsiteUrl(websiteUrl);
    if (!website.ok && !websiteUntouched) {
      setError(website.message);
      return;
    }
    setSaving(true);
    try {
      const profile = {
        name: name.trim(),
        displayName: (displayName || name).trim(),
        stableName: stableName.trim() || null,
        location: location.trim() || null,
        bio: bio.trim() || null,
        photoUrl,
        marketingVisible,
        // Sent whenever it is VALID, including as null: the route writes only the
        // keys present in the body, so omitting it when empty would make CLEARING
        // a website impossible. The only case that is omitted is an untouched
        // pre-existing value this form cannot parse (see above) - rewriting that
        // is not ours to do, and leaving the key out means the column keeps it.
        ...(website.ok ? { websiteUrl: website.value } : {}),
      };

      // `savedId` — not the `mode` prop — decides create vs update. After a
      // create whose photo copy failed we stay on the form to show the retry,
      // and the trainer now EXISTS; re-submitting must update it. Keying off
      // `isEdit` instead POSTed again, hit the slug unique constraint, and the
      // 409 copy below told the admin to change the name — which turned one
      // failed copy into two live trainers on the public site.
      const existingId = isEdit ? seed!.id : savedId;

      let trainerId: string;
      if (existingId) {
        const res = await fetch(`/api/admin/trainers/${existingId}`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(profile),
        });
        if (!res.ok) {
          setError(await readError(res));
          return;
        }
        trainerId = existingId;
        await saveContacts(trainerId);
      } else {
        const res = await fetch("/api/admin/trainers", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ ...profile, slug: slugify(name), status: "active" }),
        });
        if (!res.ok) {
          // ENG-746 - Mel's block. Gated on the error CODE as well as the status,
          // so only the slug collision gets the specific copy: any other 409 the
          // route might grow later falls through to the server's own message
          // rather than being explained as something it is not. The wording and
          // the reasoning behind it live in lib/trainers/slug-collision.ts.
          const err = await readErrorBody(res);
          setError(
            res.status === 409 && err.code === "slug_taken"
              ? slugCollisionMessage(slugify(name))
              : err.message,
          );
          return;
        }
        const { data } = await res.json();
        trainerId = data.id;
        // Recorded BEFORE any further await. The trainer row is committed at this
        // point, so if anything after this throws — saveContacts hitting a network
        // drop, say — a re-submit must UPDATE this trainer, never create a second.
        setSavedId(trainerId);
        await saveContacts(trainerId);
      }

      // The profile is saved at this point. A failed photo copy keeps us on the
      // form with a retryable warning instead of discarding a successful save.
      setSavedId(trainerId);
      if (!(await syncMarketingPhoto(trainerId))) return;

      // A successful save used to just become the trainers list with no
      // confirmation at all. Announce it, hold briefly so the toast is seen,
      // then navigate (ENG-964). Failures are untouched here: `setError` already
      // renders a `role="alert"` banner, so toasting them too would say it twice.
      showToast(existingId ? "Trainer saved." : "Trainer added.", "success");
      navTimer.current = setTimeout(() => {
        router.push("/trainers");
        router.refresh();
      }, saveToastHoldMs());
    } catch {
      // Without this, a rejection mid-save unwound silently: no message, the
      // button simply re-enabled, and the admin had no way to tell whether
      // anything had been written.
      setError("Something went wrong while saving. Some changes may already be saved — press Save again to finish, rather than reloading.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <form className="adm-form-wrap" onSubmit={onSubmit} data-testid="trainer-form">
      {error ? <div className="form-err" role="alert">{error}</div> : null}

      {publishWarning ? (
        <div className="form-warn" role="alert" data-testid="marketing-photo-warning">
          <span>{publishWarning}</span>
          <button
            type="button"
            className="btn btn-light"
            onClick={retryPublish}
            disabled={publishing}
            data-testid="retry-publish"
          >
            {publishing ? "Retrying…" : "Retry"}
          </button>
        </div>
      ) : null}

      <div className="adm-card">
        <div className="adm-card-head">
          <div>
            <h2>Trainer</h2>
            <div className="sub">Identifying information.</div>
          </div>
        </div>
        <div className="adm-card-body adm-grid">
          <div className="adm-grid-2col">
            <div>
              <label className="adm-label">Full name</label>
              <input className="adm-input" data-testid="trainer-name" value={name}
                onChange={(e) => setName(e.target.value)} placeholder="e.g. Chris Waller" />
            </div>
            <div>
              <label className="adm-label">Display name</label>
              <input className="adm-input" value={displayName}
                onChange={(e) => setDisplayName(e.target.value)} placeholder="Shown on posts and profile" />
              <div className="adm-help">Usually same as full name.</div>
            </div>
          </div>
          <div className="adm-grid-2col">
            <div>
              <label className="adm-label">Stable</label>
              <input className="adm-input" value={stableName}
                onChange={(e) => setStableName(e.target.value)} placeholder="e.g. Chris Waller Racing" />
            </div>
            <div>
              <label className="adm-label">Location</label>
              <input className="adm-input" value={location}
                onChange={(e) => setLocation(e.target.value)} placeholder="e.g. Rosehill, NSW" />
            </div>
          </div>

          {/* ENG-746 — Website. PUBLIC-facing by design: stablepass-web renders it
              as the "Website" action on the member trainer profile. It belongs in
              Trainer (identifying information) and explicitly NOT in Contacts:
              trainer_contact is internal, admin-only data (guardrail #3), and the
              two must not read to an admin as the same kind of field.

              `type="text"`, not `type="url"`, on purpose. Native URL validation
              would fire first and replace the message below with the browser's
              own — and it would not help anyway, since `javascript:alert(1)` is a
              perfectly valid absolute URL to the platform check. One rule, stated
              once, shared with the server. */}
          <div>
            <label className="adm-label" htmlFor="trainer-website">Website</label>
            <input
              id="trainer-website"
              className="adm-input"
              type="text"
              inputMode="url"
              value={websiteUrl}
              onChange={(e) => setWebsiteUrl(e.target.value)}
              placeholder="https://..."
              data-testid="trainer-website"
            />
            <div className="adm-help">
              Optional. Shown as a link on the trainer&apos;s profile in the app.
            </div>
            {websiteLegacyInvalid ? (
              <div className="adm-help adm-check-note" data-testid="website-legacy-invalid">
                The saved website is not a full web address, so the app is not showing it. Fix it
                or clear it when you can. Leaving it alone will not block this save.
              </div>
            ) : null}
          </div>
        </div>
      </div>

      <div className="adm-card">
        <div className="adm-card-head">
          <div>
            <h2>Contacts</h2>
            <div className="sub">Who the team reaches at the stable. Add the trainer plus any staff, like a racing manager.</div>
          </div>
        </div>
        <div className="adm-card-body">
          <div className="adm-contacts">
            {contacts.map((c, i) => (
              <div className="adm-contact" key={c.id ?? `new-${i}`}>
                <div className="adm-contact-head">
                  <div className={i === 0 ? "adm-contact-tag primary" : "adm-contact-tag"}>
                    Contact {i + 1} · {i === 0 ? "Trainer" : "Staff"}
                  </div>
                  {i > 0 ? (
                    <button type="button" className="adm-contact-remove" onClick={() => removeContact(i)}>
                      Remove
                    </button>
                  ) : null}
                </div>
                <div className="adm-grid-2col">
                  <div>
                    <label className="adm-label">Role</label>
                    <input className="adm-input" value={c.role}
                      onChange={(e) => setContact(i, { role: e.target.value })} placeholder="e.g. Racing manager" />
                  </div>
                  <div>
                    <label className="adm-label">Name</label>
                    <input className="adm-input" value={c.name}
                      onChange={(e) => setContact(i, { name: e.target.value })} placeholder="e.g. Sam Freedman" />
                  </div>
                  <div>
                    <label className="adm-label">Email</label>
                    <input className="adm-input" type="email" value={c.email}
                      onChange={(e) => setContact(i, { email: e.target.value })} placeholder="contact@stable.com.au" />
                  </div>
                  <div>
                    <label className="adm-label">Phone</label>
                    <input className="adm-input" type="tel" value={c.phone}
                      onChange={(e) => setContact(i, { phone: e.target.value })} placeholder="+61 4xx xxx xxx" />
                  </div>
                </div>
              </div>
            ))}
            <div className="adm-add-contact">
              <button type="button" onClick={addContact} data-testid="add-contact">+ Add another contact</button>
              <div className="adm-help">Up to a few contacts per stable, the trainer plus one or two staff.</div>
            </div>
          </div>
        </div>
      </div>

      <div className="adm-card">
        <div className="adm-card-head">
          <div>
            <h2>Profile photo</h2>
            <div className="sub">Shown on the trainer&apos;s profile page (square crop).</div>
          </div>
        </div>
        <div className="adm-card-body">
          <input ref={fileRef} type="file" accept="image/png,image/jpeg" hidden onChange={onPhoto} />
          {pendingPhoto ? (
            <PhotoCropField
              file={pendingPhoto}
              subject="trainer"
              initialCrop={pendingPhoto === sessionPick?.file ? sessionPick.crop : null}
              onCancel={() => setPendingPhoto(null)}
              onApply={uploadPhoto}
            />
          ) : null}
          <div className={photoUrl ? "upload-zone filled" : "upload-zone"}>
            {photoUrl ? (
              <>
                <div className="preview">
                  {/* eslint-disable-next-line @next/next/no-img-element -- signed Storage preview */}
                  <img src={previewUrl ?? undefined} alt="Trainer photo preview" />
                </div>
                <div className="upload-tools">
                  <div className="upload-meta">{uploading ? "Uploading…" : "Photo added"}</div>
                  <button
                    type="button"
                    className="btn btn-light"
                    style={{ padding: "6px 12px", fontSize: "12.5px" }}
                    onClick={repositionExisting}
                    disabled={preparingReposition || uploading}
                    data-testid="trainer-photo-reposition"
                  >
                    {preparingReposition ? "Loading…" : "Reposition"}
                  </button>
                  <button
                    type="button"
                    className="btn btn-light"
                    style={{ padding: "6px 12px", fontSize: "12.5px" }}
                    onClick={() => fileRef.current?.click()}
                  >
                    Replace
                  </button>
                </div>
              </>
            ) : (
              <>
                <div className="zone-title">
                  {uploading ? (
                    "Uploading…"
                  ) : (
                    <>
                      Drop image here or{" "}
                      <span className="link" role="button" tabIndex={0} onClick={() => fileRef.current?.click()}>
                        browse
                      </span>
                    </>
                  )}
                </div>
                <div className="adm-help">JPEG or PNG · up to 5 MB · ideally 800×800</div>
              </>
            )}
          </div>
        </div>
      </div>

      <div className="adm-card">
        <div className="adm-card-head">
          <div>
            <h2>Bio</h2>
            <div className="sub">A short description for the trainer&apos;s profile.</div>
          </div>
        </div>
        <div className="adm-card-body">
          <textarea className="adm-input" value={bio} onChange={(e) => setBio(e.target.value)}
            placeholder="Background, stable history, notable horses…" />
        </div>
      </div>

      {/* Marketing publication. Deliberately its OWN card, not part of Contacts:
          contacts are internal admin-only records (guardrail #3), whereas
          everything this toggle controls is public-facing by design. */}
      <div className="adm-card">
        <div className="adm-card-head">
          <div>
            <h2>Marketing site</h2>
            <div className="sub">Whether this trainer appears on the public site.</div>
          </div>
        </div>
        <div className="adm-card-body">
          <label className="adm-check" htmlFor="marketing-visible">
            <input
              id="marketing-visible"
              type="checkbox"
              checked={marketingVisible}
              onChange={(e) => setMarketingVisible(e.target.checked)}
              data-testid="marketing-visible"
            />
            <span>
              <span className="adm-check-title">Show on marketing site</span>
              <span className="adm-help">
                Publishes this trainer&apos;s name, location, bio, horses and photo on stablepass.co.
              </span>
            </span>
          </label>
          {marketingVisible && !photoUrl ? (
            <div className="adm-help adm-check-note" data-testid="marketing-no-photo">
              No photo added yet — the site will show this trainer&apos;s initials until one is.
            </div>
          ) : null}
        </div>
      </div>

      <div className="adm-form-actions">
        <Link href="/trainers" className="btn btn-light" style={{ padding: "10px 22px" }}>Cancel</Link>
        <button type="submit" className="btn btn-primary" style={{ padding: "10px 22px" }}
          disabled={saving || uploading} data-testid="submit-trainer">
          {saving ? "Saving…" : isEdit ? "Save changes" : "Add to library"}
        </button>
      </div>
      {/* Last child on purpose: the region is `position: fixed`, so its
          DOM position is cosmetic — but keeping it after the form's own
          `role="alert"` banner means it can never shadow a first-match query. */}
      <ToastRegion toasts={toasts} onDismiss={dismissToast} />
    </form>
  );
}
