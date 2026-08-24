"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Icon } from "../icons";
import LocalTime from "../LocalTime";
import HlsVideo from "./HlsVideo";
import PreviewModal from "./PreviewModal";
import PostPreview, { type PostPreviewData } from "./PostPreview";
import {
  createDraft,
  discardDraft,
  patchPost,
  publishPost,
  schedulePost,
  uploadPhotoToStorage,
  uploadVideoToMux,
} from "./api";
import { ACCEPT_BY_TYPE, isUploadType, TYPE_LABEL, uploadTypeForFile } from "./types";
import {
  MAX_PHOTOS,
  mediaSetPayload,
  mirrorPath,
  movePhoto,
  removePhotoAt,
  uploadedPhotos,
  type ComposePhoto,
} from "./photos";
import type {
  CreateDraftResponse,
  EditInitial,
  HorseOption,
  MeasureState,
  MediaDimensions,
  MediaType,
  TrainerOption,
} from "./types";
import styles from "./compose.module.css";
import { isPostLabel, POST_LABEL_PRESETS } from "@/lib/posts/labels";

/**
 * ENG-745 removed the 240-character caption cap entirely — there is deliberately
 * no `CAPTION_MAX` any more.
 *
 * It was enforced with `maxLength`, so the textarea silently swallowed every
 * keystroke past 240 and an operator pasting a long trainer quote lost the tail
 * with no message. Nothing downstream ever needed the limit: `post.body` is
 * unbounded `text`, the BFF imposes no cap, and the member feed clamps the
 * caption to two lines on the card, so a long body is a display concern that is
 * already handled rather than a data problem. The counter stays, as a passive
 * character count with no threshold and no red state.
 */
type PublishMode = "draft" | "schedule" | "publish";
type UploadState = "idle" | "creating" | "uploading" | "done" | "error";
type ActionState = { kind: "idle" | "working" | "ok" | "error"; message?: string };

/** The picker, in the mockup's order. `news` is deliberately not offered. */
const POST_TYPES: { type: MediaType; icon: "play" | "image" | "mic" | "text" }[] = [
  { type: "video", icon: "play" },
  { type: "photo", icon: "image" },
  { type: "voice", icon: "mic" },
  { type: "text", icon: "text" },
];

function objectUrl(file: File): string | null {
  if (typeof URL !== "undefined" && typeof URL.createObjectURL === "function") {
    return URL.createObjectURL(file);
  }
  return null;
}

/** Release every strip thumbnail's object URL (ENG-748). */
function revokePhotoUrls(list: readonly ComposePhoto[]): void {
  if (typeof URL === "undefined" || !URL.revokeObjectURL) return;
  for (const p of list) if (p.previewUrl?.startsWith("blob:")) URL.revokeObjectURL(p.previewUrl);
}

function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

const pad2 = (n: number) => String(n).padStart(2, "0");

/**
 * A UTC instant → the browser-local `<input type="date">` + `<input type="time">`
 * values that display it. Uses the local `Date` getters, so the split reflects
 * the operator's timezone (computed after mount to stay hydration-safe).
 */
function splitLocal(iso: string): { date: string; time: string } {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return { date: "", time: "" };
  return {
    date: `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`,
    time: `${pad2(d.getHours())}:${pad2(d.getMinutes())}`,
  };
}

/**
 * The local Date/Time pair → the absolute `Date`. `new Date("YYYY-MM-DDTHH:MM")`
 * (no offset, with a time part) is parsed in the browser's timezone, so
 * `.toISOString()` gives the correct UTC instant for the operator's local pick —
 * the exact conversion the single `datetime-local` used before. Returns null
 * until both halves are present/valid so the schedule action can stay disabled.
 */
function combineLocal(date: string, time: string): Date | null {
  if (!date || !time) return null;
  const d = new Date(`${date}T${time}`);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * Map a schedule endpoint failure to a human inline message. Reads the envelope
 * error `code` structurally (the `schedulePost` ApiError carries it) so a 409
 * `invalid_status` gets a refresh hint and a past time its own line; anything
 * else falls back to the endpoint's message.
 */
function scheduleErrorMessage(e: unknown): string {
  const code =
    e && typeof e === "object" && "code" in e ? (e as { code?: string }).code : undefined;
  if (code === "invalid_status")
    return "This post can no longer be scheduled — it may have just published. Refresh and try again.";
  if (code === "scheduled_for_in_past") return "That time is in the past — pick a future time.";
  return e instanceof Error && e.message ? e.message : "Couldn’t schedule the post.";
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
  const [title, setTitle] = useState(initial?.title ?? "");
  const [caption, setCaption] = useState(initial?.caption ?? "");
  // "" is the "No label" option; it is sent to the BFF as an explicit null.
  // Seeded from the post being edited, so an old unlabelled post opens on
  // "No label" and stays unlabelled unless the operator picks one.
  const [label, setLabel] = useState<string>(initial?.label ?? "");
  const initialLabel = initial?.label ?? "";
  /**
   * A stored label this build has no preset for still gets an <option>, so the
   * control can actually display it.
   *
   * Without one the <select> silently falls back to index 0 and reads "No
   * label" while state holds the real value — the control lying about the post
   * in front of you, and unfixable by choosing "No label" because that is
   * already what it shows, so re-picking it fires no change event.
   */
  const unknownLabel = initialLabel !== "" && !isPostLabel(initialLabel) ? initialLabel : null;
  /**
   * The category fragment every save spreads in — and it is ABSENT unless the
   * operator actually moved the picker.
   *
   * Absent, null and a preset are three different instructions to the route:
   * absent leaves the column alone, null clears it, a preset sets it. Sending
   * the current value unconditionally collapsed the first two, and that broke a
   * post whose stored label this build does not recognise — which happens the
   * moment stablepass-be adds or removes a preset and admin has not been
   * redeployed, the same skew the route's 23514 backstop exists for. The picker
   * could not display that value, so it fell back to "No label" while state
   * still held the real one; editing only the caption then either 400'd the
   * whole save or silently relabelled the post. Not writing what nobody touched
   * makes all of that go away, and is what the operator meant anyway.
   */
  const labelPatch: { label?: string | null } =
    label === initialLabel ? {} : { label: label === "" ? null : label };

  const [file, setFile] = useState<File | null>(null);
  /**
   * ENG-748 — the ordered photo set, in DISPLAY order. Photo posts only; video
   * and voice never populate it and every path below that reads it is gated on
   * the type.
   *
   * `file` / `mediaUrl` are deliberately kept alongside it rather than replaced:
   * they still describe photo 0, so the existing measurement, preview and
   * upload-status paths (and their tests) keep working untouched, and a
   * single-photo post behaves exactly as it did before this ticket. This list is
   * the source of truth for ORDER and for what gets persisted.
   */
  const [photos, setPhotos] = useState<ComposePhoto[]>([]);
  /** Cap breach and per-set upload problems — shown above the strip. */
  const [photoError, setPhotoError] = useState<string | null>(null);
  /**
   * The post type is CHOSEN up front (step 2), never inferred from the picked
   * file. Inference is what left `text` unauthorable — it has no file to sniff.
   * Video is the default: it is the common post, and it is what the mockup
   * ships selected. In edit mode the existing post's type is fixed.
   */
  const [postType, setPostType] = useState<MediaType>(initial?.mediaType ?? "video");
  /** MIME-mismatch message: the chosen type vs. what was actually picked. */
  const [typeError, setTypeError] = useState<string | null>(null);
  const [mediaUrl, setMediaUrl] = useState<string | null>(initial?.mediaUrl ?? null);
  // Intrinsic size of the picked file, measured in the browser off the local
  // object URL — never uploaded, never chosen by the operator. Starts "off":
  // edit mode previews a Mux HLS rendition whose videoWidth/videoHeight
  // describe the rendition, not the asset, so it is deliberately unmeasured
  // rather than measured wrongly (ENG-558).
  const [dims, setDims] = useState<MediaDimensions>(null);
  const [measure, setMeasure] = useState<MeasureState>("off");
  const [draft, setDraft] = useState<CreateDraftResponse | null>(null);
  const [upload, setUpload] = useState<{ state: UploadState; pct: number; error?: string }>({
    state: "idle",
    pct: 0,
  });

  const router = useRouter();
  const [mode, setMode] = useState<PublishMode>("publish");
  // The schedule pick as two browser-local halves. Start empty so the server
  // render and the first client paint match; the edit-mode prefill from
  // `scheduled_for` is filled after mount (browser TZ) — same deferred-hydration
  // discipline as <LocalTime> — so there is no hydration mismatch.
  const [scheduleDate, setScheduleDate] = useState("");
  const [scheduleTime, setScheduleTime] = useState("");
  const [previewOpen, setPreviewOpen] = useState(false);
  const [action, setAction] = useState<ActionState>({ kind: "idle" });

  useEffect(() => {
    if (!initial?.scheduledFor) return;
    // Deferred-hydration prefill (same discipline as <LocalTime>): the browser
    // timezone is unavailable during SSR, so the pick stays empty through the
    // server render + first client paint and is filled once, after mount.
    const { date, time } = splitLocal(initial.scheduledFor);
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setScheduleDate(date);
    setScheduleTime(time);
    // Mount-only prefill from the loaded post's schedule.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const fileInputRef = useRef<HTMLInputElement>(null);
  /**
   * Generation counter for "the pick currently in flight".
   *
   * `createDraft` + the byte upload are a long await, and the operator can
   * switch post type, swap horse or clear the media in the middle of it.
   * Guarding on `draft` alone cannot catch that: `draft` is only set AFTER the
   * await resolves, so during the whole network call there is nothing to see,
   * and the late `setDraft` would resurrect a draft of the OLD type into a
   * screen that has already moved on — which `runAction` would then patch and
   * publish instead of creating the post the operator actually asked for.
   *
   * Every invalidating action bumps this; an in-flight pick captures it and
   * discards its own result if it has moved.
   */
  const pickGeneration = useRef(0);

  const trainerName = useMemo(
    () => trainers.find((t) => t.id === bylineId)?.name ?? null,
    [trainers, bylineId],
  );

  /**
   * Every match, NOT the first 8 (ENG-745).
   *
   * Both branches used to `.slice(0, 8)`, which made a stable of 20 horses look
   * like a stable of 8: with the search box empty — how the picker opens — the
   * 9th horse onward was unreachable, and there was no "8 of 20" affordance to
   * suggest otherwise. The list is already scrollable (`.results` carries
   * `max-height` + `overflow-y: auto`, pinned in compose-css.test.ts), so the
   * full roster costs nothing but a scroll. The roster is client-side and in
   * the low hundreds at most, so there is no windowing concern here.
   */
  const matches = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return horses;
    return horses.filter((h) => h.name.toLowerCase().includes(q));
  }, [horses, search]);

  const isText = postType === "text";
  /** The photos that actually landed in Storage, in display order. */
  const readyPhotos = uploadedPhotos(photos);
  /**
   * The path `post.media_url` will actually be set to — the first UPLOADED
   * photo, not simply display position 0.
   *
   * The distinction is not pedantic: if the photo at position 0 failed to
   * upload, the mirror lands on the next one that did, so badging position 0 as
   * "Cover" would tell the operator the feed will show an image that was never
   * stored. Same function the save path uses, so the badge cannot disagree with
   * what gets written.
   */
  const coverPath = mirrorPath(photos);
  /**
   * The photo the cover badge is on — and therefore the one the big Step 3
   * frame and its meta line must show.
   *
   * Without this the frame kept rendering `mediaUrl`, which is the FIRST PICKED
   * file and never moves. After a reorder the screen said three different
   * things at once: the frame showed photo 1 (captioned "gallop-1.png"), the
   * strip badged photo 3 as the cover, and the member card previewed photo 3.
   * Caught in the reorder screenshot, not by a test.
   */
  const coverPhoto = photos.find((p) => p.path === coverPath) ?? null;
  /**
   * ENG-748 — the ordered photo set to persist, spread into every save.
   *
   * ABSENT unless this is a photo post with something uploaded, exactly like
   * `labelPatch`: `media` is a full replacement, so sending `[]` would delete
   * the post's photos, and sending it on a video/voice/text save would delete
   * them for a type that never had any. Absent means "leave the set alone",
   * which is what every path that is not a photo pick means.
   *
   * The paths come from `mediaSetPayload`, so display position — not upload
   * slot — decides `sort_order`, and the route mirrors position 0 into
   * `post.media_url`.
   */
  const mediaPatch: { media?: string[] } =
    postType === "photo" && readyPhotos.length > 0
      ? { media: mediaSetPayload(photos).map((r) => r.mediaUrl) }
      : {};
  /**
   * A multi-photo post is ready when at least one photo has landed and none is
   * still in flight. A failed tile does NOT block the post — the ticket's rule
   * is that the post keeps the successfully uploaded set and the strip offers a
   * retry, so the operator can drop the failure and publish the rest.
   */
  const photosSettled = photos.length > 0 && !photos.some((p) => p.state === "uploading");
  /**
   * A photo post outside edit mode ALWAYS goes through the set path, so its
   * readiness always comes from the set — never from `upload.state`.
   *
   * Gating on `photos.length > 0` instead was a real bug, caught by the
   * remove-the-last-photo test: emptying the strip fell back to `upload.state`,
   * which was still "done" from the upload that had since been removed, so the
   * screen offered to publish a photo post with no photos.
   */
  const usesPhotoSet = postType === "photo" && !isEdit;
  const draftReady =
    !!draft &&
    (usesPhotoSet ? photosSettled && readyPhotos.length > 0 : upload.state === "done");
  /**
   * A text post has no upload, so it can never satisfy `draftReady` — and its
   * draft does not even exist yet, because minting one is what picking a file
   * does for the other three types. It is ready when its CONTENT is: a horse
   * (post.horse_id is NOT NULL for every type), a byline, and a non-empty
   * body. The body requirement is enforced server-side too — the BFF is not
   * the only caller of POST /api/admin/posts.
   */
  const textReady = !!horse && !!bylineId && caption.trim().length > 0;
  const canAct = isText ? textReady : draftReady;
  const busy = action.kind === "working";
  // Both halves of the pick are required before the schedule action is allowed.
  const canSchedule = !!scheduleDate && !!scheduleTime;
  // Only draft/scheduled posts expose the edit-mode Schedule section — mirrors
  // the endpoint's lifecycle rule (guardrail §2); no client-side status bypass.
  const canReschedule = isEdit && (initial!.status === "draft" || initial!.status === "scheduled");

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
    // Invalidate any pick still in flight, so its `setDraft` cannot land after
    // this clear and re-populate what we are about to empty.
    pickGeneration.current += 1;
    if (mediaUrl && typeof URL !== "undefined" && URL.revokeObjectURL) URL.revokeObjectURL(mediaUrl);
    // Every strip thumbnail is its own object URL; dropping the list without
    // revoking them leaks one blob per photo for the life of the page, and the
    // operator can re-pick a ten-photo set as often as they like.
    revokePhotoUrls(photos);
    setPhotos([]);
    setPhotoError(null);
    setFile(null);
    setMediaUrl(null);
    setDims(null);
    setMeasure("off");
    setDraft(null);
    setTypeError(null);
    setUpload({ state: "idle", pct: 0 });
    if (fileInputRef.current) fileInputRef.current.value = "";
  }

  /**
   * Switching the post type invalidates everything downstream of it: the
   * picked file belongs to the old type, and the draft row was minted with
   * `type` already set (the route writes it at insert, and PATCH does not
   * cover `type`). So we drop the draft and reuse the SAME clear path the
   * replace-a-file flow uses, rather than inventing a second one.
   */
  function chooseType(next: MediaType) {
    if (next === postType) return;
    if (draft) void discardDraft(draft.id).catch(() => {});
    resetMedia();
    setPostType(next);
  }

  /**
   * The preview media element reports the file's intrinsic size (or null when
   * the browser can't decode it). Either way the measurement is finished, so
   * the readout stops saying "Measuring…" — a file we cannot measure is
   * advisory-only and never blocks posting.
   */
  function onMeasure(next: MediaDimensions) {
    setMeasure("done");
    setDims((prev) =>
      prev && next && prev.width === next.width && prev.height === next.height ? prev : next,
    );
  }

  async function onPickFile(picked: File) {
    if (!horse || !bylineId) {
      setUpload({ state: "error", pct: 0, error: "Pick a horse first." });
      return;
    }
    // A text post has no media step at all, so it can never reach here.
    if (!isUploadType(postType)) return;

    // VALIDATION, not classification. The operator already told us what kind
    // of post this is; a file whose MIME disagrees is an error they have to
    // resolve, never a silent reclassification of their post (ENG-611).
    const kind = uploadTypeForFile(picked);
    if (kind !== postType) {
      const got = kind ? TYPE_LABEL[kind] : picked.type || "an unrecognised file";
      setTypeError(
        `You chose ${TYPE_LABEL[postType]}, but that file is ${kind ? `a ${got}` : got}. ` +
          `Pick a ${TYPE_LABEL[postType].toLowerCase()} file, or change the post type above.`,
      );
      // Leave the chosen type, the existing file and any draft exactly as they
      // were — the pick simply did not happen.
      if (fileInputRef.current) fileInputRef.current.value = "";
      return;
    }
    setTypeError(null);

    // Replacing a file: drop the previous draft (and its uploaded asset) so we
    // don't leave an orphan draft row behind when we mint the new one.
    if (draft) void discardDraft(draft.id).catch(() => {});
    if (mediaUrl && typeof URL !== "undefined" && URL.revokeObjectURL) URL.revokeObjectURL(mediaUrl);

    setDraft(null);
    setFile(picked);
    setMediaUrl(objectUrl(picked));
    // Drop the previous file's measurement BEFORE the new one lands, so the
    // readout can never describe the file the operator just replaced.
    setDims(null);
    // Voice has no picture, so there is nothing to measure and nothing that
    // will ever fire `onMeasure` — entering "measuring" for it would leave the
    // readout stuck on "Measuring…" forever. Stay "off" so it prints nothing.
    setMeasure(kind === "voice" ? "off" : "measuring");
    setUpload({ state: "creating", pct: 0 });

    // This pick's generation. If it moves while we are awaiting, the operator
    // has changed the type / horse / file and everything below is stale.
    const generation = ++pickGeneration.current;
    const stale = () => pickGeneration.current !== generation;

    try {
      const created = await createDraft({ horseId: horse.id, type: kind, sourceTrainerId: bylineId });
      if (stale()) {
        // The operator moved on mid-flight. This draft belongs to a post they
        // no longer want, so bin it server-side and touch NO state — writing
        // it back would strand a draft of the wrong type in a screen that has
        // already switched, and `runAction` would publish that instead.
        void discardDraft(created.id).catch(() => {});
        return;
      }
      setDraft(created);
      setUpload({ state: "uploading", pct: 0 });

      if (!created.uploadUrl) throw new Error("No upload target was returned.");

      if (kind === "video") {
        await uploadVideoToMux(created.uploadUrl, picked, (pct) => {
          if (!stale()) setUpload({ state: "uploading", pct });
        });
      } else {
        // photo AND voice take the identical Storage path — same private
        // bucket, same `<postId>/original` object, same signed-upload token.
        // The bytes go browser → Storage; they never transit our server.
        await uploadPhotoToStorage({
          bucket: created.bucket!,
          path: created.path!,
          token: created.token!,
          file: picked,
        });
      }
      if (stale()) return;
      setUpload({ state: "done", pct: 100 });
    } catch (e) {
      // A failure that belongs to an abandoned pick must not surface an error
      // against the post the operator has since switched to.
      if (stale()) return;
      setUpload({ state: "error", pct: 0, error: (e as Error).message });
    }
  }

  /**
   * ENG-748 — pick one OR MORE photos.
   *
   * Photo posts only; every other type still goes through `onPickFile`
   * unchanged. A one-file pick here produces exactly the same draft, the same
   * `<postId>/original` object and the same `post.media_url` as before this
   * ticket — the multi path is not a separate mode, it is the same path with a
   * count.
   */
  async function onPickPhotos(picked: File[]) {
    if (!horse || !bylineId) {
      setUpload({ state: "error", pct: 0, error: "Pick a horse first." });
      return;
    }
    if (picked.length === 0) return;

    // THE CAP, enforced before anything is created or uploaded — "11 files
    // picked: blocked with a message, nothing uploads". Checked here rather than
    // left to the route so the operator is told immediately, and checked against
    // the whole pick because this replaces the set rather than appending to it.
    if (picked.length > MAX_PHOTOS) {
      setPhotoError(
        `You can add up to ${MAX_PHOTOS} photos to a post — you picked ${picked.length}. Nothing was uploaded.`,
      );
      if (fileInputRef.current) fileInputRef.current.value = "";
      return;
    }

    // MIME validation over the WHOLE set before any upload, same rule as the
    // single pick: one video dragged in with nine photos is an error the
    // operator resolves, never a silent reclassification of the post.
    const wrong = picked.find((f) => uploadTypeForFile(f) !== "photo");
    if (wrong) {
      const kind = uploadTypeForFile(wrong);
      setTypeError(
        `You chose Photo, but “${wrong.name}” is ${kind ? `a ${TYPE_LABEL[kind]}` : wrong.type || "an unrecognised file"}. ` +
          `Pick photo files only, or change the post type above.`,
      );
      if (fileInputRef.current) fileInputRef.current.value = "";
      return;
    }
    setTypeError(null);
    setPhotoError(null);

    if (draft) void discardDraft(draft.id).catch(() => {});
    if (mediaUrl && typeof URL !== "undefined" && URL.revokeObjectURL) URL.revokeObjectURL(mediaUrl);
    revokePhotoUrls(photos);

    setDraft(null);
    // photo 0 also drives the existing single-file UI + measurement, so the
    // readout and the card ratio keep describing the cover image.
    setFile(picked[0]);
    setMediaUrl(objectUrl(picked[0]));
    setDims(null);
    setMeasure("measuring");
    setUpload({ state: "creating", pct: 0 });
    setPhotos([]);

    const generation = ++pickGeneration.current;
    const stale = () => pickGeneration.current !== generation;

    try {
      const created = await createDraft({
        horseId: horse.id,
        type: "photo",
        sourceTrainerId: bylineId,
        // ONLY for a genuine multi-pick. `photoCount: 1` and an absent
        // `photoCount` are identical server-side, so omitting it means a
        // single-photo post sends the byte-identical request this endpoint has
        // always received — nothing downstream can tell this ticket shipped.
        ...(picked.length > 1 ? { photoCount: picked.length } : {}),
      });
      if (stale()) {
        void discardDraft(created.id).catch(() => {});
        return;
      }
      // `uploads` is the multi-photo shape; the four top-level fields are the
      // shape this endpoint has always returned. Falling back to them means a
      // ONE-photo pick still works against a route that predates this ticket
      // (and against every caller that mocks the old shape) — the single-photo
      // path degrades instead of breaking. A multi-photo pick genuinely cannot
      // proceed without the extra targets, so it still fails loudly.
      const targets =
        created.uploads?.length
          ? created.uploads
          : created.uploadUrl && created.path && created.token && created.bucket
            ? [
                {
                  sortOrder: 0,
                  path: created.path,
                  token: created.token,
                  uploadUrl: created.uploadUrl,
                  bucket: created.bucket,
                },
              ]
            : [];
      if (targets.length < picked.length) throw new Error("No upload target was returned.");

      setDraft(created);
      setUpload({ state: "uploading", pct: 0 });

      // Seed the strip up front so the operator watches all N tiles resolve,
      // rather than seeing them appear one at a time as each upload finishes.
      const seeded: ComposePhoto[] = picked.map((f, slot) => ({
        id: `${created.id}-${slot}`,
        path: targets[slot].path,
        previewUrl: objectUrl(f),
        name: f.name,
        size: f.size,
        state: "uploading",
        file: f,
        bucket: targets[slot].bucket,
        token: targets[slot].token,
      }));
      setPhotos(seeded);

      // Sequential, not Promise.all: ten parallel Storage PUTs from one browser
      // is what makes the slowest of them time out, and the strip is more
      // legible resolving in order. Each settles its own tile, so one failure
      // leaves the rest of the set intact — the ticket's mid-way-failure rule.
      for (let slot = 0; slot < picked.length; slot++) {
        const target = targets[slot];
        try {
          await uploadPhotoToStorage({
            bucket: target.bucket,
            path: target.path,
            token: target.token,
            file: picked[slot],
          });
          if (stale()) return;
          setPhotos((prev) =>
            prev.map((p) => (p.path === target.path ? { ...p, state: "done" } : p)),
          );
        } catch (e) {
          if (stale()) return;
          setPhotos((prev) =>
            prev.map((p) =>
              p.path === target.path ? { ...p, state: "error", error: (e as Error).message } : p,
            ),
          );
        }
      }
      if (stale()) return;
      setUpload({ state: "done", pct: 100 });
    } catch (e) {
      if (stale()) return;
      setUpload({ state: "error", pct: 0, error: (e as Error).message });
    }
  }

  /**
   * Reorder the strip. The move itself is `movePhoto`; what matters HERE is
   * that nothing else has to happen — the Storage paths do not move, so there
   * is nothing to re-upload, and `post.media_url` is recomputed from the new
   * position 0 at save time by `mirrorPath`.
   */
  function reorderPhoto(index: number, direction: -1 | 1) {
    setPhotos((prev) => movePhoto(prev, index, direction));
  }

  /** Re-PUT one failed photo's bytes to its existing slot target. */
  async function retryPhoto(index: number) {
    const target = photos[index];
    if (!target?.file || !target.bucket || !target.token) return;
    setPhotos((prev) =>
      prev.map((p) => (p.path === target.path ? { ...p, state: "uploading", error: undefined } : p)),
    );
    try {
      await uploadPhotoToStorage({
        bucket: target.bucket,
        path: target.path,
        token: target.token,
        file: target.file,
      });
      setPhotos((prev) =>
        prev.map((p) => (p.path === target.path ? { ...p, state: "done" } : p)),
      );
    } catch (e) {
      setPhotos((prev) =>
        prev.map((p) =>
          p.path === target.path ? { ...p, state: "error", error: (e as Error).message } : p,
        ),
      );
    }
  }

  function dropPhoto(index: number) {
    setPhotos((prev) => {
      const gone = prev[index];
      const next = removePhotoAt(prev, index);
      // Only after the list no longer references it, and only for a local blob.
      if (gone) revokePhotoUrls([gone]);
      return next;
    });
    setPhotoError(null);
  }

  async function runAction(next: PublishMode) {
    if (isText) {
      // The body IS the post for a text type, so an empty one is blocked here
      // as well as server-side.
      if (!horse || !bylineId) {
        setAction({ kind: "error", message: "Pick a horse first." });
        return;
      }
      if (!caption.trim()) {
        setAction({ kind: "error", message: "A text post needs a body." });
        return;
      }
    } else if (!draft || !draftReady) {
      setAction({ kind: "error", message: `Upload a ${TYPE_LABEL[postType].toLowerCase()} first.` });
      return;
    }
    setMode(next);

    // Validate the schedule BEFORE any network round-trip.
    let when: Date | null = null;
    if (next === "schedule") {
      when = combineLocal(scheduleDate, scheduleTime);
      if (!when) {
        setAction({ kind: "error", message: "Pick a date and time to schedule." });
        return;
      }
      if (when.getTime() <= Date.now()) {
        setAction({ kind: "error", message: "That time is in the past — pick a future time." });
        return;
      }
    }

    setAction({ kind: "working" });
    try {
      // A text post's draft is minted HERE, not at the media pick — it has no
      // media pick. The route returns 202 with just the draft and no upload
      // target, so there is nothing to upload afterwards.
      let current = draft;
      if (!current) {
        current = await createDraft({
          horseId: horse!.id,
          type: postType,
          sourceTrainerId: bylineId,
          title: title.trim() || undefined,
          body: caption,
          ...labelPatch,
        });
        setDraft(current);
      }

      // Persist the editable title + byline + caption before the lifecycle action.
      await patchPost(current.id, {
        title: title.trim() || null,
        body: caption,
        sourceTrainerId: bylineId,
        ...labelPatch,
        ...mediaPatch,
      });

      if (next === "publish") {
        await publishPost(current.id);
        setAction({ kind: "ok", message: "Published to subscribers." });
      } else if (next === "schedule") {
        await schedulePost(current.id, when!.toISOString());
        setAction({ kind: "ok", message: "Scheduled." });
      } else {
        setAction({ kind: "ok", message: "Saved as draft." });
      }
      // The draft is no longer ours to manage once the action succeeded. Held
      // on to, a later `chooseType`/`changeHorse` would fire a DELETE at a
      // now-PUBLISHED post; the endpoint refuses it (409, draft-only), but the
      // client swallowed that silently. Clearing it means we never ask.
      setDraft(null);
      // Any successful action (publish / schedule / draft) → land on Posts
      // (refresh so the new/updated post shows in the library).
      router.push("/posts");
      router.refresh();
    } catch (e) {
      // Schedule failures get the per-code inline message (e.g. a clock-skew
      // past time the client guard let through); other actions surface raw.
      setAction({
        kind: "error",
        message: next === "schedule" ? scheduleErrorMessage(e) : (e as Error).message,
      });
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
      setTitle("");
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
      await patchPost(initial.id, {
        title: title.trim() || null,
        body: caption,
        sourceTrainerId: bylineId,
        ...labelPatch,
      });
      setAction({ kind: "ok", message: "Changes saved." });
      router.push("/posts");
      router.refresh();
    } catch (e) {
      setAction({ kind: "error", message: (e as Error).message });
    }
  }

  // Edit mode, draft only: persist the edits, then flip the draft live via the
  // publish endpoint (it accepts draft + scheduled).
  async function publishDraftNow() {
    if (!initial) return;
    setAction({ kind: "working" });
    try {
      await patchPost(initial.id, {
        title: title.trim() || null,
        body: caption,
        sourceTrainerId: bylineId,
        ...labelPatch,
      });
      await publishPost(initial.id);
      setAction({ kind: "ok", message: "Post published." });
      router.push("/posts");
      router.refresh();
    } catch (e) {
      setAction({ kind: "error", message: (e as Error).message });
    }
  }

  // Edit mode, draft or scheduled only: persist the field edits (same order as
  // the publish path), then (re)schedule via the endpoint — which itself enforces
  // the draft/scheduled lifecycle rule and the future-time constraint. Endpoint
  // errors (scheduled_for_in_past / validation_failed / invalid_status) surface
  // inline via `scheduleErrorMessage`.
  async function scheduleEdit() {
    if (!initial) return;
    const when = combineLocal(scheduleDate, scheduleTime);
    if (!when) {
      setAction({ kind: "error", message: "Pick a date and time to schedule." });
      return;
    }
    if (when.getTime() <= Date.now()) {
      setAction({ kind: "error", message: "That time is in the past — pick a future time." });
      return;
    }
    setAction({ kind: "working" });
    try {
      await patchPost(initial.id, {
        title: title.trim() || null,
        body: caption,
        sourceTrainerId: bylineId,
        ...labelPatch,
      });
      await schedulePost(initial.id, when.toISOString());
      setAction({
        kind: "ok",
        message: initial.status === "scheduled" ? "Schedule updated." : "Scheduled.",
      });
      router.push("/posts");
      router.refresh();
    } catch (e) {
      setAction({ kind: "error", message: scheduleErrorMessage(e) });
    }
  }

  const previewData: PostPreviewData = {
    horseName: horse?.name ?? null,
    byline: trainerName,
    caption,
    // A text post genuinely has no media, so it reports none. PostPreview
    // (ENG-558 / A1) already handles a null media type without crashing —
    // `resolveAspect` takes `MediaType | null` and the media children are
    // guarded on `mediaUrl && mediaType === …` — so no guard is re-added here,
    // and A1's files are not touched.
    mediaType: isText ? null : postType,
    // For a multi-photo post the single-image slot shows DISPLAY POSITION 0 —
    // the same photo `mirrorPath` will write into `post.media_url` — so the
    // card the operator is looking at is the card a subscriber gets. Falls back
    // to the plain `mediaUrl` for every other type and for a single photo.
    mediaUrl:
      (postType === "photo" && photos.find((p) => p.path === coverPath)?.previewUrl) || mediaUrl,
    photos:
      postType === "photo" && photos.length > 1
        ? photos.map((p) => p.previewUrl ?? "").filter(Boolean)
        : undefined,
    // Real race-day data off the picked horse — the badge used to be hardcoded
    // on every post, which made the preview claim a race that wasn't running.
    racesToday: horse?.racesToday ?? false,
    dims,
    measure,
  };

  const primaryLabel =
    mode === "publish" ? "Publish now" : mode === "schedule" ? "Schedule" : "Save as draft";
  const mediaLabel = isText
    ? "None — text post"
    : photos.length > 1
      ? `${photos.length} photos`
      : file || mediaUrl
        ? `1 ${postType}`
        : "None yet";

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
            <>
              <button
                type="button"
                className={`btn ${initial?.status === "draft" ? styles.btnLight : "btn-primary"} ${styles.btnSm}`}
                onClick={saveEdit}
                disabled={busy}
              >
                {busy ? "Saving…" : "Save changes"}
              </button>
              {initial?.status === "draft" && (
                <button
                  type="button"
                  className={`btn btn-primary ${styles.btnSm}`}
                  data-testid="publish-draft"
                  onClick={publishDraftNow}
                  disabled={busy}
                >
                  {busy ? "Working…" : "Publish now"}
                </button>
              )}
            </>
          ) : (
            <>
              <button
                type="button"
                className={`btn ${styles.btnLight} ${styles.btnSm}`}
                onClick={() => runAction("draft")}
                disabled={!canAct || busy}
              >
                Save draft
              </button>
              <button
                type="button"
                className={`btn ${styles.btnLight} ${styles.btnSm}`}
                onClick={() => runAction("schedule")}
                disabled={!canAct || busy}
              >
                Schedule
              </button>
              <button
                type="button"
                className={`btn btn-primary ${styles.btnSm}`}
                onClick={() => runAction("publish")}
                disabled={!canAct || busy}
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
                                /* Lazy since ENG-745 dropped the slice(0, 8):
                                   the list is the whole roster now, but only
                                   ~4 rows are visible in the 260px scroll box,
                                   so eager loading would fire one signed-URL
                                   request per horse the moment the picker
                                   opens. The directive below must stay on the
                                   line directly above the <img>. */
                                // eslint-disable-next-line @next/next/no-img-element -- remote horse thumb, fixed box
                                <img src={h.photoUrl} alt="" loading="lazy" />
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

            {/* STEP 2 — post type. Chosen, never sniffed. In edit mode the
                type is fixed: PATCH does not cover `post.type`, and changing
                it would orphan the already-uploaded asset. */}
            <section className={styles.section}>
              <div className={styles.stepLabel}>Step 2 · Post type</div>
              <h3 className={styles.sectionTitle}>What kind of post is this?</h3>

              {isEdit ? (
                // Edit mode: the type is FIXED. PATCH does not cover
                // `post.type`, and changing it would orphan the asset already
                // uploaded against this post. Rendered read-only rather than
                // omitted, so the steps stay 1-2-3-4 instead of jumping 1-3-4
                // and leaving the operator to wonder what step 2 was.
                <div className={styles.readOnlyRow} data-testid="type-fixed">
                  <span className={styles.readOnlyValue}>
                    <Icon name={POST_TYPES.find((p) => p.type === postType)?.icon ?? "play"} />
                    {TYPE_LABEL[postType]}
                  </span>
                  <span className={styles.help}>
                    The post type can&apos;t be changed after the post is created.
                  </span>
                </div>
              ) : (
                <>
                <div
                  className={styles.typePicker}
                  role="radiogroup"
                  aria-label="Post type"
                  data-testid="type-picker"
                >
                  {POST_TYPES.map(({ type, icon }) => (
                    <label
                      key={type}
                      className={`${styles.typeOption} ${postType === type ? styles.typeOptionSelected : ""}`}
                      data-testid={`type-option-${type}`}
                      data-selected={postType === type ? "true" : undefined}
                    >
                      <input
                        type="radio"
                        name="post-type"
                        value={type}
                        checked={postType === type}
                        onChange={() => chooseType(type)}
                      />
                      <Icon name={icon} />
                      {TYPE_LABEL[type]}
                    </label>
                  ))}
                </div>
                {/* The mockup's line, STATIC and always visible — deliberately
                    not gated on Text being selected. It is the only place the
                    operator learns a text post exists and what it does, so
                    revealing it only after they pick Text would show it exactly
                    when it is no longer needed. */}
                <div className={styles.help}>
                  Text posts have no media: the title and body are the whole post, and they render
                  as a Stable update in the app.
                </div>
                </>
              )}
            </section>

            {/* STEP 3 — media. Hidden ENTIRELY for a text post: not a disabled
                zone, not an empty frame — there is no media step. */}
            {!isText ? (
            <section className={styles.section}>
              <div className={styles.stepLabel}>Step 3 · Media</div>
              <h3 className={styles.sectionTitle}>Add the content.</h3>

              <input
                ref={fileInputRef}
                className={styles.hiddenFile}
                type="file"
                accept={isUploadType(postType) ? ACCEPT_BY_TYPE[postType] : undefined}
                // ENG-748 — multi-select for PHOTO only, and not in edit mode
                // (media is read-only there). Video is a single Mux asset and
                // voice a single Storage object, so neither may offer it.
                multiple={postType === "photo" && !isEdit}
                data-testid="media-input"
                onChange={(e) => {
                  const picked = Array.from(e.target.files ?? []);
                  if (picked.length === 0) return;
                  // A photo post always goes through the set path, even for one
                  // file — one code path, so the single-photo case cannot drift
                  // away from the multi one.
                  if (postType === "photo" && !isEdit) void onPickPhotos(picked);
                  else void onPickFile(picked[0]);
                }}
              />

              {isEdit ? (
                <div className={`${styles.uploadZone} ${styles.filled}`} data-testid="media-existing">
                  <div
                    className={`${styles.preview} ${postType === "voice" ? styles.previewAudio : ""}`}
                  >
                    {postType === "photo" && mediaUrl ? (
                      // eslint-disable-next-line @next/next/no-img-element -- signed existing media
                      <img src={mediaUrl} alt="" />
                    ) : postType === "video" && mediaUrl ? (
                      // Signed Mux HLS URL hydrated by the edit page loader.
                      <HlsVideo src={mediaUrl} controls playsInline preload="metadata" />
                    ) : postType === "voice" && mediaUrl ? (
                      <audio src={mediaUrl} controls preload="metadata" data-testid="voice-existing" />
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
                      Existing {postType} · media can’t be changed when editing.
                    </span>
                  </div>
                </div>
              ) : file ? (
                <div className={`${styles.uploadZone} ${styles.filled}`} data-testid="media-filled">
                  <div
                    className={`${styles.preview} ${postType === "voice" ? styles.previewAudio : ""}`}
                  >
                    {postType === "photo" && (coverPhoto?.previewUrl ?? mediaUrl) ? (
                      // The COVER, not the first file picked — see coverPhoto.
                      // eslint-disable-next-line @next/next/no-img-element -- local object URL preview
                      <img src={coverPhoto?.previewUrl ?? mediaUrl!} alt="" />
                    ) : postType === "video" && mediaUrl ? (
                      // Playable local preview of the picked file (object URL);
                      // native controls replace the decorative play glyph.
                      <HlsVideo src={mediaUrl} controls playsInline preload="metadata" />
                    ) : postType === "voice" && mediaUrl ? (
                      // Voice has no visual, so the local object URL is offered
                      // as a playable audio element rather than a blank frame.
                      <audio src={mediaUrl} controls preload="metadata" data-testid="voice-preview" />
                    ) : null}
                  </div>
                  {upload.state === "uploading" ? (
                    <div className={styles.progressTrack}>
                      <div className={styles.progressFill} style={{ width: `${upload.pct}%` }} />
                    </div>
                  ) : null}
                  <div className={styles.uploadTools}>
                    <span className={styles.uploadMeta}>
                      {/* Names the cover for a photo set, so the frame and its
                          caption cannot describe two different photos. */}
                      {coverPhoto?.name ?? file.name} ·{" "}
                      {humanSize(coverPhoto?.size ?? file.size)}
                      {photos.length > 1 ? ` · cover of ${photos.length}` : ""}
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
                        {/* A photo pick REPLACES the whole set, so say so once
                            there is more than one to lose. */}
                        {photos.length > 1 ? "Replace all" : "Replace"}
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
                    <span className={styles.dropTitle}>
                      Choose {postType === "voice" ? "an audio file" : `a ${postType}`}
                    </span>
                    <span className={styles.dropSub}>
                      {postType === "video"
                        ? "Video goes to Mux — straight from your browser."
                        : "Goes to private storage — straight from your browser."}
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
              {/* ENG-748 — the ordering strip. Present only for a photo post
                  that actually has photos, and only outside edit mode (media is
                  read-only there). Deliberately rendered for a ONE-photo set
                  too: the tile is where "Add more" and the upload state live,
                  and hiding it until a second photo appears would mean the
                  single-photo operator never sees either.

                  Up/down buttons, not drag — resolved open question, v1. */}
              {!isEdit && postType === "photo" && photos.length > 0 ? (
                <>
                  <div className={styles.photoStrip} data-testid="photo-strip">
                    {photos.map((p, i) => (
                      <div
                        key={p.id}
                        className={`${styles.photoTile} ${p.state === "error" ? styles.photoTileBad : ""}`}
                        data-testid={`photo-tile-${i}`}
                      >
                        <div className={styles.photoThumbWrap}>
                          {p.previewUrl ? (
                            // eslint-disable-next-line @next/next/no-img-element -- local object URL
                            <img className={styles.photoThumb} src={p.previewUrl} alt="" />
                          ) : null}
                          {/* 1-based: the operator counts photos from one, and
                              this is the number they reorder by. sort_order is
                              0-based on the wire and is never shown. */}
                          <span className={styles.photoPos} data-testid={`photo-pos-${i}`}>
                            {i + 1}
                          </span>
                          {/* Position 0 is what post.media_url mirrors — the
                              image the feed, the card and every existing client
                              shows for this post. Naming it "Cover" is what
                              makes the reorder's consequence visible. */}
                          {p.path === coverPath ? (
                            <span className={styles.photoCover} data-testid="photo-cover">
                              Cover
                            </span>
                          ) : null}
                        </div>
                        <div className={styles.photoTools}>
                          <button
                            type="button"
                            className={styles.photoBtn}
                            onClick={() => reorderPhoto(i, -1)}
                            disabled={i === 0}
                            aria-label={`Move photo ${i + 1} earlier`}
                            data-testid={`photo-up-${i}`}
                          >
                            ↑
                          </button>
                          <button
                            type="button"
                            className={styles.photoBtn}
                            onClick={() => reorderPhoto(i, 1)}
                            disabled={i === photos.length - 1}
                            aria-label={`Move photo ${i + 1} later`}
                            data-testid={`photo-down-${i}`}
                          >
                            ↓
                          </button>
                          <button
                            type="button"
                            className={`${styles.photoBtn} ${styles.photoBtnKill}`}
                            onClick={() => dropPhoto(i)}
                            aria-label={`Remove photo ${i + 1}`}
                            data-testid={`photo-remove-${i}`}
                          >
                            ×
                          </button>
                        </div>
                        <div
                          className={`${styles.photoState} ${p.state === "error" ? styles.photoStateBad : ""}`}
                          data-testid={`photo-state-${i}`}
                          title={p.error ?? p.name}
                        >
                          {p.state === "uploading" ? (
                            "uploading…"
                          ) : p.state === "done" ? (
                            humanSize(p.size)
                          ) : (
                            <button
                              type="button"
                              className={styles.photoBtn}
                              onClick={() => void retryPhoto(i)}
                              data-testid={`photo-retry-${i}`}
                            >
                              failed — retry
                            </button>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                  <div className={styles.help} data-testid="photo-strip-help">
                    {photos.length} of {MAX_PHOTOS} photos. The first is the cover — it is what the
                    feed and the member card show.
                  </div>
                </>
              ) : null}

              {photoError ? (
                <div
                  className={`${styles.help} ${styles.uploadError}`}
                  data-testid="photo-error"
                  role="alert"
                >
                  {photoError}
                </div>
              ) : null}

              {/* The chosen type vs. what was actually picked. Named on both
                  sides so the operator can see which half to change. */}
              {typeError ? (
                <div
                  className={`${styles.help} ${styles.uploadError}`}
                  data-testid="type-mismatch"
                  role="alert"
                >
                  {typeError}
                </div>
              ) : null}
              <div className={styles.help}>
                Upload the finished file, already edited and watermarked. The platform doesn&apos;t
                modify what you upload.
              </div>
            </section>
            ) : null}

            {/* STEP 4 — words. For a text post the body IS the post, so the
                field is required and labelled as such. */}
            <section className={styles.section}>
              <div className={styles.stepLabel}>Step 4 · Words</div>
              <h3 className={styles.sectionTitle}>
                {isText ? "Write the post." : "Write the caption."}
              </h3>

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

              <label className={styles.label} htmlFor="post-title">
                Title
              </label>
              <input
                id="post-title"
                className={styles.input}
                type="text"
                value={title}
                data-testid="title"
                placeholder="Last fast gallop before Saturday"
                onChange={(e) => setTitle(e.target.value)}
                style={{ marginBottom: 14 }}
              />

              {/*
                ENG-745 — the editorial category behind the green pill on the
                member card. A <select> rather than a row of 13 pills: at 13
                presets a pill row wraps to three lines and swamps the two
                fields it sits between, and this matches the Trainer byline
                control directly above it, which is the metadata section's
                established language in the mockup.

                "No label" is a real, selectable option, not a disabled
                placeholder — clearing a category is something an operator must
                be able to do, and it is the state every pre-2026-08-19 post is
                already in.
              */}
              <label className={styles.label} htmlFor="post-label">
                Label
              </label>
              <select
                id="post-label"
                className={styles.select}
                value={label}
                data-testid="label-select"
                onChange={(e) => setLabel(e.target.value)}
                style={{ marginBottom: 14 }}
              >
                <option value="">No label</option>
                {unknownLabel ? (
                  // Not one of this build's presets — shown so the operator can
                  // see what the post actually carries and decide, instead of
                  // the control quietly claiming it has none.
                  <option value={unknownLabel}>{unknownLabel} (not in this version)</option>
                ) : null}
                {POST_LABEL_PRESETS.map((preset) => (
                  <option key={preset} value={preset}>
                    {preset}
                  </option>
                ))}
              </select>

              <div className={styles.captionRow}>
                <label className={styles.label} htmlFor="caption">
                  {isText ? "Body" : "Caption"}
                  {isText ? <span aria-hidden="true"> *</span> : null}
                </label>
                {/* Passive count, no threshold and no red state — there is no
                    limit left to be over (ENG-745). */}
                <span className={styles.counter} data-testid="caption-counter">
                  {caption.length} characters
                </span>
              </div>
              <textarea
                id="caption"
                className={styles.textarea}
                value={caption}
                required={isText}
                aria-required={isText || undefined}
                data-testid="caption"
                placeholder={
                  isText
                    ? "Mahogany worked well this morning — he's spot-on for Saturday…"
                    : "Last fast gallop before Saturday — he's spot-on…"
                }
                onChange={(e) => setCaption(e.target.value)}
              />
              <div className={styles.help}>
                {isText
                  ? "Required — the title and this body are the whole post. Write it so it sounds like the trainer would say it."
                  : "Sounds like the trainer would say it. The feed shows the first couple of lines, so lead with what matters."}
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
                  ) : canAct ? (
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
                <div className={styles.dateTimeRow}>
                  <div className={styles.dateTimeField}>
                    <label className={styles.subLabel} htmlFor="schedule-date">
                      Date
                    </label>
                    <input
                      id="schedule-date"
                      className={styles.input}
                      type="date"
                      value={scheduleDate}
                      data-testid="schedule-date"
                      onChange={(e) => setScheduleDate(e.target.value)}
                    />
                  </div>
                  <div className={styles.dateTimeField}>
                    <label className={styles.subLabel} htmlFor="schedule-time">
                      Time
                    </label>
                    <input
                      id="schedule-time"
                      className={styles.input}
                      type="time"
                      step={60}
                      value={scheduleTime}
                      data-testid="schedule-time"
                      onChange={(e) => setScheduleTime(e.target.value)}
                    />
                  </div>
                </div>
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
                  disabled={
                    isEdit ? busy : !canAct || busy || (mode === "schedule" && !canSchedule)
                  }
                >
                  {busy ? (isEdit ? "Saving…" : "Working…") : isEdit ? "Save changes" : primaryLabel}
                </button>
                <button
                  type="button"
                  className={`btn ${styles.btnLight} btn-block`}
                  onClick={() => setPreviewOpen(true)}
                >
                  Preview post
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

            {/* Edit-mode scheduling — drafts + scheduled posts only. Published /
                unpublished posts show no scheduling UI (guardrail §2). */}
            {canReschedule ? (
              <div className={styles.side} data-testid="edit-schedule">
                <h4 className={styles.sideTitle}>Schedule</h4>
                {initial!.scheduledFor ? (
                  <div className={styles.row}>
                    <span className={styles.rowLbl}>Scheduled for</span>
                    <span className={styles.rowVal} data-testid="current-schedule">
                      <LocalTime iso={initial!.scheduledFor} kind="when" />
                    </span>
                  </div>
                ) : null}
                <div className={styles.dateTimeRow} style={{ marginTop: 14 }}>
                  <div className={styles.dateTimeField}>
                    <label className={styles.subLabel} htmlFor="edit-schedule-date">
                      Date
                    </label>
                    <input
                      id="edit-schedule-date"
                      className={styles.input}
                      type="date"
                      value={scheduleDate}
                      data-testid="schedule-date"
                      onChange={(e) => setScheduleDate(e.target.value)}
                    />
                  </div>
                  <div className={styles.dateTimeField}>
                    <label className={styles.subLabel} htmlFor="edit-schedule-time">
                      Time
                    </label>
                    <input
                      id="edit-schedule-time"
                      className={styles.input}
                      type="time"
                      step={60}
                      value={scheduleTime}
                      data-testid="schedule-time"
                      onChange={(e) => setScheduleTime(e.target.value)}
                    />
                  </div>
                </div>
                <button
                  type="button"
                  className="btn btn-primary btn-block"
                  data-testid="schedule-action"
                  style={{ marginTop: 12 }}
                  onClick={scheduleEdit}
                  disabled={!canSchedule || busy}
                >
                  {busy
                    ? "Saving…"
                    : initial!.status === "scheduled"
                      ? "Update schedule"
                      : "Schedule"}
                </button>
                <div className={styles.help} style={{ marginTop: 8 }}>
                  Shown in your timezone. Goes live automatically at the time you set.
                </div>
              </div>
            ) : null}

            {/* Inline preview — the SAME component the modal renders, at the
                sidebar scale. This used to be a hand-rolled copy of the card
                (hardcoded "Race day", caption above the reactions, raw racing
                name); a third copy is how the other two drifted. It is also
                the always-mounted instance, so it owns measurement. */}
            <div className={styles.side}>
              <h4 className={styles.sideTitle}>Preview</h4>
              {/* Only a locally-picked file is measurable — see MeasureState. */}
              <PostPreview
                data={previewData}
                compact
                onMeasure={file ? onMeasure : undefined}
              />
            </div>
          </div>
        </div>
      </div>

      <PreviewModal open={previewOpen} onClose={() => setPreviewOpen(false)} data={previewData} />
    </>
  );
}
