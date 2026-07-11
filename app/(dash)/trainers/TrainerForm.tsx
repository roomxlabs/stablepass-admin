"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { supabaseBrowser } from "@/lib/supabase/client";

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

async function readError(res: Response): Promise<string> {
  try {
    const j = await res.json();
    return j?.error?.message ?? `Request failed (${res.status}).`;
  } catch {
    return `Request failed (${res.status}).`;
  }
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
  const [photoUrl, setPhotoUrl] = useState<string | null>(seed?.photoUrl ?? null);
  const [contacts, setContacts] = useState<ContactInput[]>(
    isEdit && props.contacts.length ? props.contacts : [emptyContact("Trainer")],
  );
  const [removed, setRemoved] = useState<string[]>([]);
  const [uploading, setUploading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

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

  async function onPhoto(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setError(null);
    setUploading(true);
    try {
      const ext = file.name.split(".").pop() || "jpg";
      const path = `${slugify(name || "trainer")}-${Date.now()}.${ext}`;
      const { error: upErr } = await supabaseBrowser()
        .storage.from(PHOTO_BUCKET)
        .upload(path, file, { upsert: true });
      if (upErr) {
        setError(`Photo upload failed: ${upErr.message}`);
      } else {
        setPhotoUrl(path);
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

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!name.trim()) {
      setError("Full name is required.");
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
      };

      if (isEdit) {
        const res = await fetch(`/api/admin/trainers/${seed!.id}`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(profile),
        });
        if (!res.ok) {
          setError(await readError(res));
          return;
        }
        await saveContacts(seed!.id);
      } else {
        const res = await fetch("/api/admin/trainers", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ ...profile, slug: slugify(name), status: "active" }),
        });
        if (!res.ok) {
          setError(
            res.status === 409
              ? "A trainer with a matching name already exists — adjust the name."
              : await readError(res),
          );
          return;
        }
        const { data } = await res.json();
        await saveContacts(data.id);
      }
      router.push("/trainers");
      router.refresh();
    } finally {
      setSaving(false);
    }
  }

  return (
    <form className="adm-form-wrap" onSubmit={onSubmit} data-testid="trainer-form">
      {error ? <div className="form-err" role="alert">{error}</div> : null}

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
          <div className="upload-zone">
            <div className="zone-title">
              {uploading
                ? "Uploading…"
                : photoUrl
                  ? "Photo added"
                  : <>Drop image here or <span className="link" role="button" tabIndex={0}
                      onClick={() => fileRef.current?.click()}>browse</span></>}
            </div>
            <div className="adm-help">JPEG or PNG · up to 5 MB · ideally 800×800</div>
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

      <div className="adm-form-actions">
        <Link href="/trainers" className="btn btn-light" style={{ padding: "10px 22px" }}>Cancel</Link>
        <button type="submit" className="btn btn-primary" style={{ padding: "10px 22px" }}
          disabled={saving || uploading} data-testid="submit-trainer">
          {saving ? "Saving…" : isEdit ? "Save changes" : "Add to library"}
        </button>
      </div>
    </form>
  );
}
