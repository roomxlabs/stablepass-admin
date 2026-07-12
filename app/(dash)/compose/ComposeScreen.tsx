"use client";

import { useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Icon } from "../icons";
import PreviewModal from "./PreviewModal";
import type { PostPreviewData } from "./PostPreview";
import {
  createDraft,
  discardDraft,
  patchPost,
  publishPost,
  schedulePost,
  uploadPhotoToStorage,
  uploadVideoToMux,
} from "./api";
import type { CreateDraftResponse, EditInitial, HorseOption, MediaType, TrainerOption } from "./types";
import styles from "./compose.module.css";

const CAPTION_MAX = 240;
type PublishMode = "draft" | "schedule" | "publish";
type UploadState = "idle" | "creating" | "uploading" | "done" | "error";
type ActionState = { kind: "idle" | "working" | "ok" | "error"; message?: string };

function mediaTypeForFile(file: File): MediaType | null {
  if (file.type.startsWith("video/")) return "video";
  if (file.type.startsWith("image/")) return "photo";
  return null;
}

function objectUrl(file: File): string | null {
  if (typeof URL !== "undefined" && typeof URL.createObjectURL === "function") {
    return URL.createObjectURL(file);
  }
  return null;
}

function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export default function ComposeScreen({
  horses,
  trainers,
  initial,
}: {
  horses: HorseOption[];
  trainers: TrainerOption[];
  initial?: EditInitial;
}) {
  const isEdit = !!initial;
  const [search, setSearch] = useState(initial?.horse.name ?? "");
  const [showResults, setShowResults] = useState(false);
  const [horse, setHorse] = useState<HorseOption | null>(initial?.horse ?? null);
  const [bylineId, setBylineId] = useState<string>(initial?.bylineId ?? "");
  const [caption, setCaption] = useState(initial?.caption ?? "");

  const [file, setFile] = useState<File | null>(null);
  const [mediaType, setMediaType] = useState<MediaType | null>(initial?.mediaType ?? null);
  const [mediaUrl, setMediaUrl] = useState<string | null>(initial?.mediaUrl ?? null);
  const [draft, setDraft] = useState<CreateDraftResponse | null>(null);
  const [upload, setUpload] = useState<{ state: UploadState; pct: number; error?: string }>({
    state: "idle",
    pct: 0,
  });

  const router = useRouter();
  const [mode, setMode] = useState<PublishMode>("publish");
  const [scheduledFor, setScheduledFor] = useState("");
  const [previewOpen, setPreviewOpen] = useState(false);
  const [action, setAction] = useState<ActionState>({ kind: "idle" });

  const fileInputRef = useRef<HTMLInputElement>(null);

  const trainerName = useMemo(
    () => trainers.find((t) => t.id === bylineId)?.name ?? null,
    [trainers, bylineId],
  );

  const matches = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return horses.slice(0, 8);
    return horses.filter((h) => h.name.toLowerCase().includes(q)).slice(0, 8);
  }, [horses, search]);

  const draftReady = !!draft && upload.state === "done";
  const busy = action.kind === "working";

  function selectHorse(h: HorseOption) {
    setHorse(h);
    setSearch(h.name);
    setShowResults(false);
    // Byline pre-fills from the horse's stable trainer; still editable below.
    setBylineId(h.trainerId ?? "");
  }

  function changeHorse() {
    // The draft (if any) was minted against the old horse — drop it too.
    if (draft) void discardDraft(draft.id).catch(() => {});
    resetMedia();
    setHorse(null);
    setSearch("");
    setShowResults(true);
  }

  function resetMedia() {
    if (mediaUrl && typeof URL !== "undefined" && URL.revokeObjectURL) URL.revokeObjectURL(mediaUrl);
    setFile(null);
    setMediaType(null);
    setMediaUrl(null);
    setDraft(null);
    setUpload({ state: "idle", pct: 0 });
    if (fileInputRef.current) fileInputRef.current.value = "";
  }

  async function onPickFile(picked: File) {
    if (!horse || !bylineId) {
      setUpload({ state: "error", pct: 0, error: "Pick a horse first." });
      return;
    }
    const kind = mediaTypeForFile(picked);
    if (!kind) {
      setUpload({ state: "error", pct: 0, error: "Only a video or a photo can be uploaded here." });
      return;
    }

    // Replacing a file: drop the previous draft (and its uploaded asset) so we
    // don't leave an orphan draft row behind when we mint the new one.
    if (draft) void discardDraft(draft.id).catch(() => {});
    if (mediaUrl && typeof URL !== "undefined" && URL.revokeObjectURL) URL.revokeObjectURL(mediaUrl);

    setDraft(null);
    setFile(picked);
    setMediaType(kind);
    setMediaUrl(objectUrl(picked));
    setUpload({ state: "creating", pct: 0 });

    try {
      const created = await createDraft({ horseId: horse.id, type: kind, sourceTrainerId: bylineId });
      setDraft(created);
      setUpload({ state: "uploading", pct: 0 });

      if (kind === "video") {
        await uploadVideoToMux(created.uploadUrl, picked, (pct) =>
          setUpload({ state: "uploading", pct }),
        );
      } else {
        await uploadPhotoToStorage({
          bucket: created.bucket!,
          path: created.path!,
          token: created.token!,
          file: picked,
        });
      }
      setUpload({ state: "done", pct: 100 });
    } catch (e) {
      setUpload({ state: "error", pct: 0, error: (e as Error).message });
    }
  }

  async function runAction(next: PublishMode) {
    if (!draft || !draftReady) {
      setAction({ kind: "error", message: "Upload a video or photo first." });
      return;
    }
    setMode(next);

    // Validate the schedule BEFORE any network round-trip.
    let when: Date | null = null;
    if (next === "schedule") {
      when = new Date(scheduledFor);
      if (!scheduledFor || Number.isNaN(when.getTime())) {
        setAction({ kind: "error", message: "Pick a valid date & time to schedule." });
        return;
      }
      if (when.getTime() <= Date.now()) {
        setAction({ kind: "error", message: "Schedule a time in the future." });
        return;
      }
    }

    setAction({ kind: "working" });
    try {
      // Persist the editable byline + caption before the lifecycle action.
      await patchPost(draft.id, { body: caption, sourceTrainerId: bylineId });

      if (next === "publish") {
        await publishPost(draft.id);
        setAction({ kind: "ok", message: "Published to subscribers." });
      } else if (next === "schedule") {
        await schedulePost(draft.id, when!.toISOString());
        setAction({ kind: "ok", message: "Scheduled." });
      } else {
        setAction({ kind: "ok", message: "Saved as draft." });
      }
      // Any successful action (publish / schedule / draft) → land on Posts
      // (refresh so the new/updated post shows in the library).
      router.push("/posts");
      router.refresh();
    } catch (e) {
      setAction({ kind: "error", message: (e as Error).message });
    }
  }

  async function onDiscard() {
    if (!draft) {
      resetMedia();
      return;
    }
    setAction({ kind: "working" });
    try {
      await discardDraft(draft.id);
      resetMedia();
      setCaption("");
      setAction({ kind: "ok", message: "Draft discarded." });
    } catch (e) {
      setAction({ kind: "error", message: (e as Error).message });
    }
  }

  // Edit mode: PATCH the editable fields (caption + byline) on the existing
  // post — horse and media are fixed here (the PATCH contract covers neither).
  async function saveEdit() {
    if (!initial) return;
    setAction({ kind: "working" });
    try {
      await patchPost(initial.id, { body: caption, sourceTrainerId: bylineId });
      setAction({ kind: "ok", message: "Changes saved." });
      router.push("/posts");
      router.refresh();
    } catch (e) {
      setAction({ kind: "error", message: (e as Error).message });
    }
  }

  const previewData: PostPreviewData = {
    horseName: horse?.name ?? null,
    byline: trainerName,
    caption,
    mediaType,
    mediaUrl,
  };

  const captionOver = caption.length > CAPTION_MAX;
  const primaryLabel =
    mode === "publish" ? "Publish now" : mode === "schedule" ? "Schedule" : "Save as draft";
  const mediaLabel = mediaType ? `1 ${mediaType}` : "None yet";

  return (
    <>
      <div className="admin-topbar">
        <h1>{isEdit ? "Edit post" : "Compose post"}</h1>
        <div className="actions">
          <Link href="/posts" className={styles.cancelLink}>
            Cancel
          </Link>
          <button
            type="button"
            className={`btn ${styles.btnLight} ${styles.btnSm}`}
            onClick={() => setPreviewOpen(true)}
          >
            Preview
          </button>
          {isEdit ? (
            <button
              type="button"
              className={`btn btn-primary ${styles.btnSm}`}
              onClick={saveEdit}
              disabled={busy}
            >
              {busy ? "Saving…" : "Save changes"}
            </button>
          ) : (
            <>
              <button
                type="button"
                className={`btn ${styles.btnLight} ${styles.btnSm}`}
                onClick={() => runAction("draft")}
                disabled={!draftReady || busy}
              >
                Save draft
              </button>
              <button
                type="button"
                className={`btn ${styles.btnLight} ${styles.btnSm}`}
                onClick={() => runAction("schedule")}
                disabled={!draftReady || busy}
              >
                Schedule
              </button>
              <button
                type="button"
                className={`btn btn-primary ${styles.btnSm}`}
                onClick={() => runAction("publish")}
                disabled={!draftReady || busy}
              >
                Publish
              </button>
            </>
          )}
        </div>
      </div>

      <div className="admin-content">
        <div className={styles.grid}>
          {/* LEFT COLUMN --------------------------------------------------- */}
          <div>
            {/* STEP 1 — horse */}
            <section className={styles.section}>
              <div className={styles.stepLabel}>Step 1 · Attribute</div>
              <h3 className={styles.sectionTitle}>Which horse is this for?</h3>
              <label className={styles.label} htmlFor="horse-search">
                Horse
              </label>
              <div className={styles.searchWrap}>
                {!isEdit ? (
                  <input
                    id="horse-search"
                    className={styles.input}
                    type="text"
                    placeholder="Search horses by name…"
                    value={search}
                    autoComplete="off"
                    data-testid="horse-search"
                    onChange={(e) => {
                      setSearch(e.target.value);
                      setShowResults(true);
                      if (horse && e.target.value !== horse.name) setHorse(null);
                    }}
                    onFocus={() => setShowResults(true)}
                  />
                ) : null}
                {showResults && !horse ? (
                  <ul className={styles.results} data-testid="horse-results">
                    {matches.length === 0 ? (
                      <li className={styles.noResults}>No horses match “{search}”.</li>
                    ) : (
                      matches.map((h) => (
                        <li key={h.id}>
                          <button
                            type="button"
                            className={styles.resultRow}
                            data-testid={`horse-opt-${h.id}`}
                            onClick={() => selectHorse(h)}
                          >
                            <span className={styles.resultThumb}>
                              {h.photoUrl ? (
                                // eslint-disable-next-line @next/next/no-img-element -- remote horse thumb, fixed box
                                <img src={h.photoUrl} alt="" />
                              ) : null}
                            </span>
                            <span>
                              <span className={styles.resultName}>{h.name}</span>
                              <span className={styles.resultSub}>
                                {h.trainerName ? `by ${h.trainerName}` : "no trainer set"}
                                {h.stableName ? ` · ${h.stableName}` : ""}
                              </span>
                            </span>
                          </button>
                        </li>
                      ))
                    )}
                  </ul>
                ) : null}
              </div>
              <div className={styles.help}>
                Posts attach to the horse, not the trainer. The trainer byline is set from the
                horse&apos;s stable.
              </div>

              {horse ? (
                <div className={styles.horsePick} style={{ marginTop: 12 }} data-testid="horse-pick">
                  <div className={styles.pickThumb}>
                    {horse.photoUrl ? (
                      // eslint-disable-next-line @next/next/no-img-element -- remote horse photo, fixed box
                      <img src={horse.photoUrl} alt="" />
                    ) : (
                      (horse.name.trim()[0] ?? "H").toUpperCase()
                    )}
                  </div>
                  <div className={styles.pickMeta}>
                    <p className={styles.pickName}>{horse.name}</p>
                    <div className={styles.pickSub}>
                      {horse.trainerName ? `by ${horse.trainerName}` : "no trainer set"}
                      {horse.stableName ? ` · ${horse.stableName}` : ""}
                      {!isEdit ? (
                        <button type="button" className={styles.changeLink} onClick={changeHorse}>
                          Change horse
                        </button>
                      ) : null}
                    </div>
                  </div>
                </div>
              ) : null}
            </section>

            {/* STEP 2 — media */}
            <section className={styles.section}>
              <div className={styles.stepLabel}>Step 2 · Media</div>
              <h3 className={styles.sectionTitle}>Add the content.</h3>

              <input
                ref={fileInputRef}
                className={styles.hiddenFile}
                type="file"
                accept="video/*,image/*"
                data-testid="media-input"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) void onPickFile(f);
                }}
              />

              {isEdit ? (
                <div className={`${styles.uploadZone} ${styles.filled}`} data-testid="media-existing">
                  <div className={styles.preview}>
                    {mediaType === "photo" && mediaUrl ? (
                      // eslint-disable-next-line @next/next/no-img-element -- signed existing media
                      <img src={mediaUrl} alt="" />
                    ) : (
                      <span className={styles.previewPlay}>
                        <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
                          <polygon points="8 5 20 12 8 19 8 5" fill="currentColor" />
                        </svg>
                      </span>
                    )}
                  </div>
                  <div className={styles.uploadTools}>
                    <span className={styles.uploadMeta}>
                      Existing {mediaType} · media can’t be changed when editing.
                    </span>
                  </div>
                </div>
              ) : file ? (
                <div className={`${styles.uploadZone} ${styles.filled}`} data-testid="media-filled">
                  <div className={styles.preview}>
                    {mediaType === "photo" && mediaUrl ? (
                      // eslint-disable-next-line @next/next/no-img-element -- local object URL preview
                      <img src={mediaUrl} alt="" />
                    ) : mediaType === "video" && mediaUrl ? (
                      <>
                        <video src={mediaUrl} muted playsInline preload="metadata" />
                        <span className={styles.previewPlay}>
                          <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
                            <polygon points="8 5 20 12 8 19 8 5" fill="currentColor" />
                          </svg>
                        </span>
                      </>
                    ) : null}
                  </div>
                  {upload.state === "uploading" ? (
                    <div className={styles.progressTrack}>
                      <div className={styles.progressFill} style={{ width: `${upload.pct}%` }} />
                    </div>
                  ) : null}
                  <div className={styles.uploadTools}>
                    <span className={styles.uploadMeta}>
                      {file.name} · {humanSize(file.size)}
                      {"  "}
                      {upload.state === "creating" || upload.state === "uploading" ? (
                        <span className={styles.uploadStatus}> · uploading{upload.state === "uploading" && upload.pct ? ` ${upload.pct}%` : "…"}</span>
                      ) : upload.state === "done" ? (
                        <span className={styles.uploadStatus} data-testid="upload-done"> · uploaded</span>
                      ) : upload.state === "error" ? (
                        <span className={`${styles.uploadStatus} ${styles.uploadError}`}> · {upload.error}</span>
                      ) : null}
                    </span>
                    <span className={styles.uploadActions}>
                      <button type="button" className={styles.uploadBtn} onClick={() => fileInputRef.current?.click()}>
                        Replace
                      </button>
                      <button type="button" className={styles.uploadBtn} onClick={resetMedia}>
                        Remove
                      </button>
                    </span>
                  </div>
                </div>
              ) : (
                <div className={styles.uploadZone}>
                  <label className={styles.dropCta}>
                    <span className={styles.dropIcon}>
                      <Icon name="play" />
                    </span>
                    <span className={styles.dropTitle}>Choose a video or photo</span>
                    <span className={styles.dropSub}>
                      Video goes to Mux, photos to storage — straight from your browser.
                    </span>
                    <button
                      type="button"
                      className={`btn ${styles.btnLight} ${styles.btnSm}`}
                      style={{ marginTop: 12 }}
                      onClick={() => fileInputRef.current?.click()}
                      disabled={!horse}
                    >
                      Select file
                    </button>
                  </label>
                  {upload.state === "error" ? (
                    <div className={`${styles.help} ${styles.uploadError}`} data-testid="media-error">
                      {upload.error}
                    </div>
                  ) : null}
                </div>
              )}
              <div className={styles.help}>
                Upload the finished file, already edited and watermarked. The platform doesn&apos;t
                modify what you upload.
              </div>
            </section>

            {/* STEP 3 — words */}
            <section className={styles.section}>
              <div className={styles.stepLabel}>Step 3 · Words</div>
              <h3 className={styles.sectionTitle}>Write the caption.</h3>

              <label className={styles.label} htmlFor="byline">
                Trainer byline
              </label>
              <select
                id="byline"
                className={styles.select}
                value={bylineId}
                data-testid="byline-select"
                onChange={(e) => setBylineId(e.target.value)}
                style={{ marginBottom: 14 }}
              >
                <option value="" disabled>
                  Select a trainer…
                </option>
                {trainers.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
              </select>

              <div className={styles.captionRow}>
                <label className={styles.label} htmlFor="caption">
                  Caption
                </label>
                <span className={`${styles.counter} ${captionOver ? styles.counterOver : ""}`}>
                  {caption.length}/{CAPTION_MAX}
                </span>
              </div>
              <textarea
                id="caption"
                className={styles.textarea}
                value={caption}
                maxLength={CAPTION_MAX}
                data-testid="caption"
                placeholder="Last fast gallop before Saturday — he's spot-on…"
                onChange={(e) => setCaption(e.target.value)}
              />
              <div className={styles.help}>
                Keep it under {CAPTION_MAX} characters; sounds like the trainer would say it.
              </div>
            </section>
          </div>

          {/* RIGHT COLUMN -------------------------------------------------- */}
          <div>
            <div className={styles.side}>
              <h4 className={styles.sideTitle}>Publish</h4>
              <div className={styles.row}>
                <span className={styles.rowLbl}>Status</span>
                <span className={styles.rowVal}>
                  {isEdit ? (
                    <span
                      className={`${styles.pill} ${initial!.status === "published" ? styles.pillGreen : styles.pillAmber} ${styles.pillDot}`}
                    >
                      {initial!.status.charAt(0).toUpperCase() + initial!.status.slice(1)}
                    </span>
                  ) : draftReady ? (
                    <span className={`${styles.pill} ${styles.pillGreen} ${styles.pillDot}`}>Ready</span>
                  ) : (
                    <span className={`${styles.pill} ${styles.pillAmber} ${styles.pillDot}`}>Draft</span>
                  )}
                </span>
              </div>
              <div className={styles.row}>
                <span className={styles.rowLbl}>Visibility</span>
                <span className={styles.rowVal}>Subscribers only</span>
              </div>
              <div className={styles.row}>
                <span className={styles.rowLbl}>Media</span>
                <span className={styles.rowVal}>{mediaLabel}</span>
              </div>

              {!isEdit ? (
                <>
              <label className={`${styles.label} ${styles.whenLabel}`}>When to publish</label>

              <label className={styles.radioRow}>
                <input
                  type="radio"
                  name="schedule"
                  checked={mode === "draft"}
                  onChange={() => setMode("draft")}
                />
                <span>
                  <span className={styles.radioStrong}>Save as draft</span>
                  <div className={styles.radioHelp}>Keep working on it. Nothing goes live.</div>
                </span>
              </label>

              <label className={styles.radioRow}>
                <input
                  type="radio"
                  name="schedule"
                  checked={mode === "schedule"}
                  onChange={() => setMode("schedule")}
                />
                <span>
                  <span className={styles.radioStrong}>Schedule for later</span>
                  <div className={styles.radioHelp}>Goes live automatically at the time you set.</div>
                </span>
              </label>
              {mode === "schedule" ? (
                <input
                  className={`${styles.input} ${styles.scheduleInput}`}
                  type="datetime-local"
                  value={scheduledFor}
                  data-testid="schedule-input"
                  onChange={(e) => setScheduledFor(e.target.value)}
                />
              ) : null}

              <label className={styles.radioRow}>
                <input
                  type="radio"
                  name="schedule"
                  checked={mode === "publish"}
                  onChange={() => setMode("publish")}
                />
                <span>
                  <span className={styles.radioStrong}>Publish now</span>
                  <div className={styles.radioHelp}>Goes live to subscribers straight away.</div>
                </span>
              </label>
                </>
              ) : null}

              <div className={styles.publishActions}>
                <button
                  type="button"
                  className="btn btn-primary btn-block"
                  data-testid="primary-action"
                  onClick={isEdit ? saveEdit : () => runAction(mode)}
                  disabled={isEdit ? busy : !draftReady || busy}
                >
                  {busy ? (isEdit ? "Saving…" : "Working…") : isEdit ? "Save changes" : primaryLabel}
                </button>
                <button
                  type="button"
                  className={`btn ${styles.btnLight} btn-block`}
                  onClick={() => setPreviewOpen(true)}
                >
                  Preview on mobile &amp; web
                </button>
                {!isEdit ? (
                  <button
                    type="button"
                    className={styles.discardBtn}
                    onClick={onDiscard}
                    disabled={!draft || busy}
                  >
                    Discard draft
                  </button>
                ) : null}
              </div>

              {action.kind === "ok" ? (
                <div className={`${styles.actionNote} ${styles.actionOk}`} data-testid="action-note" role="status">
                  {action.message}
                </div>
              ) : action.kind === "error" ? (
                <div className={`${styles.actionNote} ${styles.actionErr}`} data-testid="action-note" role="alert">
                  {action.message}
                </div>
              ) : (
                <div className={styles.actionNote}>
                  Push notifications are member-controlled — publishing here doesn&apos;t change that.
                </div>
              )}
            </div>

            {/* Inline mini preview */}
            <div className={styles.side}>
              <h4 className={styles.sideTitle}>Preview · mobile &amp; web</h4>
              <div className={styles.miniWrap}>
                <div className={styles.miniCard}>
                  <div className={styles.miniHead}>
                    <div className={styles.miniAvatar} aria-hidden="true">
                      {(horse?.name.trim()[0] ?? "S").toUpperCase()}
                    </div>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div className={styles.miniName}>{horse?.name ?? "Select a horse"}</div>
                      <div className={styles.miniBy}>
                        {trainerName ? `by ${trainerName} · just now` : "just now"}
                      </div>
                    </div>
                    <span className={`${styles.pill} ${styles.pillGreen} ${styles.pillDot}`} style={{ fontSize: "10.5px" }}>
                      Race day
                    </span>
                  </div>
                  <div className={styles.miniMedia}>
                    {mediaUrl && mediaType === "photo" ? (
                      // eslint-disable-next-line @next/next/no-img-element -- local object URL preview
                      <img src={mediaUrl} alt="" />
                    ) : mediaUrl && mediaType === "video" ? (
                      <video src={mediaUrl} muted playsInline preload="metadata" />
                    ) : null}
                  </div>
                  <div className={styles.miniBody}>
                    {caption.trim() ? caption : "Your caption will appear here."}
                  </div>
                </div>
              </div>
              <div className={`${styles.help} ${styles.miniCaption}`}>
                This is the mobile feed. Use Preview to see mobile &amp; web side by side.
              </div>
            </div>
          </div>
        </div>
      </div>

      <PreviewModal open={previewOpen} onClose={() => setPreviewOpen(false)} data={previewData} />
    </>
  );
}
