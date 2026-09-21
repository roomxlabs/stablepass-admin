"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Icon } from "../icons";
import LocalTime from "../LocalTime";
import HlsVideo from "./HlsVideo";
import PosterScrubber from "./PosterScrubber";
import PreviewModal from "./PreviewModal";
import PostPreview, { type PostPreviewData } from "./PostPreview";
import {
  createByline,
  createDraft,
  createPostLabel,
  discardDraft,
  patchPost,
  publishPost,
  requestPhotoUploads,
  retireByline,
  retireLabel,
  schedulePost,
  uploadPhotoToStorage,
  uploadVideoToMux,
} from "./api";
import {
  ACCEPT_BY_TYPE,
  isUploadType,
  STABLEPASS_HANDLE,
  SUBJECT_LABEL,
  SUBJECTS,
  trainerSubline,
  TYPE_LABEL,
  TYPES_BY_SUBJECT,
  uploadTypeForFile,
} from "./types";
import {
  MAX_PHOTOS,
  appendCapError,
  appendPhotos,
  nextPhotoSlot,
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
  PhotoUploadTarget,
  PosterTimePatch,
  Subject,
  TrainerOption,
} from "./types";
import styles from "./compose.module.css";
import { MAX_LABEL_LENGTH, POST_LABEL_PRESETS } from "@/lib/posts/labels";
import { MAX_BYLINE_LENGTH } from "@/lib/posts/bylines";

/**
 * The picker's "+ Add new…" sentinel.
 *
 * A value no real category can collide with: `post_label_name_not_blank`
 * requires a btrim'd non-empty name, and the Add-new route rejects anything
 * over MAX_LABEL_LENGTH, but neither stops an operator naming a label
 * "__add_new__". The leading/trailing underscores plus the ZERO-WIDTH-free
 * ASCII shape keep it typeable-but-implausible; the onChange handler returns
 * early on it so it can never reach `label` state or a save payload.
 */
const ADD_NEW_VALUE = "__stablepass_add_new_label__";

/**
 * The byline picker's "+ Add new…" sentinel (ENG-1268).
 *
 * Its OWN constant, not a shared one: the two pickers sit on the same screen
 * and a shared sentinel would make a stray handler swap silently work. Same
 * shape and the same rule as the label sentinel — it is an ACTION and must
 * never reach `byline` state, or a save would try to write it to `post.byline`
 * and trip the `post_byline_name_fk`.
 */
const ADD_NEW_BYLINE_VALUE = "__stablepass_add_new_byline__";

/**
 * Fallback option list when the server hands none down. Hoisted to a module
 * constant rather than written inline as a default parameter: a fresh array
 * literal on every render gives `options`' useMemo a new dependency each time,
 * so it would recompute forever.
 */
const DEFAULT_LABELS: string[] = [...POST_LABEL_PRESETS];

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

/**
 * ENG-1266 — the strip's starting state when Compose opens on an existing post.
 *
 * Every entry is `done` by definition: these objects are already in Storage,
 * which is what makes them removable, reorderable and saveable straight away.
 * `previewUrl` is the loader's short-lived SIGNED url (never a blob), so
 * `revokePhotoUrls` leaves it alone — it only revokes `blob:` urls.
 *
 * `file` / `token` / `bucket` are deliberately absent: there is nothing to
 * re-upload for a photo that is already there, and a retry button on it would
 * have no target to PUT to.
 *
 * Non-photo posts (and create mode) start empty.
 */
function initialPhotos(initial: EditInitial | undefined): ComposePhoto[] {
  if (!initial || initial.mediaType !== "photo") return [];
  return (initial.photos ?? []).map((photo, i) => ({
    id: `existing-${i}-${photo.path}`,
    path: photo.path,
    previewUrl: photo.url,
    // The object path's last segment is the only name an existing photo has —
    // the operator's original filename was never stored.
    name: photo.path.split("/").pop() ?? photo.path,
    size: 0,
    state: "done",
  }));
}

/** ENG-1266 — the one sentence for "you removed them all". */
/**
 * ENG-1268 — the confirm shown when switching subject would throw work away.
 *
 * A subject switch discards the draft for the same reason switching horse
 * does: the draft row carries `subject` from the insert and PATCH will not
 * move it, so the post in flight cannot become the post they now want.
 */
const DISCARD_ON_SUBJECT_SWITCH =
  "Changing who this post is from will discard the draft and the media you have uploaded. Continue?";

const PHOTO_REQUIRED = "A photo post needs at least one photo.";
/**
 * ENG-1266 — the same sentence for "you saved before the bytes landed".
 *
 * An edit save sends `mediaSetPayload(photos)`, which is the DONE tiles only,
 * and `PATCH /posts/:id` deletes every `post_media` row above the set it is
 * given. So saving mid-upload does not "save the photo later" — it drops the
 * in-flight photo AND trims the rows, under a cheerful "Changes saved.".
 * Create mode has always gated on `photosSettled`; this is edit mode's half.
 */
const PHOTO_UPLOADING = "A photo is still uploading. Wait for it to finish, or remove it.";

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
  labels = DEFAULT_LABELS,
  labelActions = [],
  bylines = [],
}: {
  horses: HorseOption[];
  trainers: TrainerOption[];
  initial?: EditInitial;
  /**
   * ENG-1268 — the title/label rows that may be RETIRED, with the id the
   * route needs and the `isBuiltin` flag that decides whether the × is offered
   * at all.
   *
   * Separate from `labels` on purpose. `labels` is the value list and has a
   * guaranteed floor (the 14 builtins) for when the server read comes back
   * empty; this list must NOT have one, because offering a retire button for a
   * row we never read would call `DELETE /post-labels/:id` with an invented
   * id. Empty here means "no retire actions", which is the safe failure.
   */
  labelActions?: { id: string; name: string; isBuiltin: boolean }[];
  /**
   * ENG-1268 — the non-retired `post_byline` rows, for the StablePass
   * subject's byline dropdown. Read server-side by page.tsx for the same
   * first-paint reason the labels are.
   *
   * Every row here is retirable: `post_byline` has no `is_builtin` column —
   * the whole vocabulary is admin-managed.
   */
  bylines?: { id: string; name: string }[];
  /**
   * ENG-979 — the live category list, read server-side from `post_label` and
   * handed down by page.tsx. The picker renders THIS, not the compile-time
   * `POST_LABEL_PRESETS` copy, because since ENG-978 the allowed set is a table
   * an admin can add to at runtime.
   *
   * Defaults to the 14 builtins rather than to `[]`. Those rows are pinned
   * immutable in the database (`post_label_immutable_builtin`), so they are the
   * one set guaranteed to exist — which makes them the right floor if the
   * server read comes back empty. An empty picker would read to an operator as
   * "the feature is broken", and the likeliest response is to publish with no
   * category at all, which is the exact state this epic exists to remove.
   */
  labels?: string[];
}) {
  const isEdit = !!initial;
  /**
   * ENG-1266 — the post's `post_media` read failed, so we do NOT know its photo
   * set. Everything photo-editing is switched off for this session: no strip,
   * no Add-more, and — the important one — `media` is never sent, because a
   * save built on a set we could not read would delete the rows we never saw.
   * See page.tsx's loader.
   */
  const photosUnavailable = !!initial?.photosUnavailable;
  /**
   * ENG-1268 — WHO this post is posted as.
   *
   * IMMUTABLE once the post exists: `PATCH /posts/:id` rejects a `subject`
   * key, so edit mode seeds this from the row and shows it read-only, exactly
   * as the post type has been shown since ENG-611. Create mode opens on
   * `horse`, which is what every post was before this ticket.
   */
  const [subject, setSubject] = useState<Subject>(initial?.subject ?? "horse");
  const [search, setSearch] = useState(initial?.horse?.name ?? "");
  const [showResults, setShowResults] = useState(false);
  const [horse, setHorse] = useState<HorseOption | null>(initial?.horse ?? null);
  const [bylineId, setBylineId] = useState<string>(initial?.bylineId ?? "");

  // --- Trainer subject (ENG-1268) ------------------------------------------
  /**
   * The trainer this post is BY, for the `trainer` subject. Distinct from
   * `bylineId`, which is the horse subject's byline trainer: a horse post is
   * attributed to a trainer, a trainer post IS the trainer, and collapsing the
   * two would make "change the byline" silently change who the post is from.
   */
  const [trainer, setTrainer] = useState<TrainerOption | null>(initial?.trainer ?? null);
  const [trainerSearch, setTrainerSearch] = useState(initial?.trainer?.name ?? "");
  const [showTrainerResults, setShowTrainerResults] = useState(false);

  // --- StablePass subject (ENG-1268) ---------------------------------------
  /**
   * The chosen `post_byline` NAME (never an id) — what `post.byline` stores.
   * "" is "nothing chosen yet", which the server rejects.
   */
  const [byline, setByline] = useState<string>(initial?.byline ?? "");
  const initialByline = initial?.byline ?? "";
  /** Bylines added through Add-new during THIS session — same idiom as `addedLabels`. */
  const [addedBylines, setAddedBylines] = useState<{ id: string; name: string }[]>([]);
  const [addingByline, setAddingByline] = useState(false);
  const [newByline, setNewByline] = useState("");
  const [bylineAddBusy, setBylineAddBusy] = useState(false);
  const [bylineAddError, setBylineAddError] = useState<string | null>(null);
  /** Rows retired in THIS session, so the picker drops them without a reload. */
  const [retiredBylineIds, setRetiredBylineIds] = useState<string[]>([]);
  const [retiredLabelNames, setRetiredLabelNames] = useState<string[]>([]);
  /** The manage disclosures, and the row currently mid-retire. */
  const [manageLabels, setManageLabels] = useState(false);
  const [manageBylines, setManageBylines] = useState(false);
  const [retiringId, setRetiringId] = useState<string | null>(null);
  const [retireError, setRetireError] = useState<string | null>(null);
  const [caption, setCaption] = useState(initial?.caption ?? "");
  // "" is the "No label" option; it is sent to the BFF as an explicit null.
  // Seeded from the post being edited, so an old unlabelled post opens on
  // "No label" and stays unlabelled unless the operator picks one.
  const [label, setLabel] = useState<string>(initial?.label ?? "");
  const initialLabel = initial?.label ?? "";

  /**
   * ENG-979 — categories added through Add-new during THIS compose session.
   *
   * Held separately from the `labels` prop because that prop is a server render
   * of `post_label` and does not change until the route re-renders. Merging
   * here is what makes the created category appear in the picker and be
   * selectable in the same interaction, which is the whole point of Add-new.
   */
  const [addedLabels, setAddedLabels] = useState<string[]>([]);

  /**
   * The option list: the server's live rows, plus anything added this session,
   * plus the post's own stored label if it is in neither.
   *
   * That last case is not hypothetical. A post can carry a label that was
   * removed from `post_label`, or that this render simply did not read; without
   * an <option> for it the <select> silently falls back to index 0 and reads
   * "No label" while state holds the real value — the control lying about the
   * post in front of you, and unfixable by choosing "No label", because that is
   * already what it displays, so re-picking it fires no change event.
   */
  const options = useMemo(() => {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const name of [
      // ENG-1268 — a title retired in THIS session leaves the picker without a
      // reload. The post's OWN value is appended after this filter, so
      // retiring the title you are currently using still cannot blank it.
      ...labels.filter((n) => !retiredLabelNames.includes(n)),
      ...addedLabels,
      ...(initialLabel ? [initialLabel] : []),
    ]) {
      if (name && !seen.has(name)) {
        seen.add(name);
        out.push(name);
      }
    }
    return out;
  }, [labels, addedLabels, initialLabel, retiredLabelNames]);

  /**
   * THE BYLINE PICKER'S OPTIONS — and the belt that keeps the edit path honest.
   *
   * `bylines` is already filtered to NON-RETIRED rows (A2 put that filter on
   * the route and page.tsx mirrors it). But a post can carry a retired byline
   * perfectly legitimately: `post.byline` stores the NAME, and retiring only
   * stamps `post_byline.retired_at` — it never touches `post`. Hand a <select>
   * a current value with no matching <option> and it falls back to index 0:
   * the control reads "Choose a byline" while state holds the real one, and it
   * cannot be corrected by re-picking, because that is already what it shows,
   * so no change event fires. The post's own attribution is then blanked or
   * rewritten on the next save, with no error anywhere.
   *
   * So the post's own value is unioned back in — the same fix the LABEL picker
   * has carried since ENG-979 (`options` above), copied rather than reinvented.
   * `.rx/gotchas.md` names this byline picker as the live hazard.
   *
   * It is an ORDINARY SELECTABLE OPTION, not a disabled one: the operator must
   * be able to move off a retired byline, and a disabled option they cannot
   * leave is a worse trap than the one it fixes. `retiredBylineIds` drops rows
   * retired in this session, but never the post's own value — retiring the
   * byline you are currently using must not blank the post in front of you.
   */
  const bylineOptions = useMemo(() => {
    const seen = new Set<string>();
    const out: { id: string | null; name: string }[] = [];
    for (const row of [
      ...bylines.filter((b) => !retiredBylineIds.includes(b.id)),
      ...addedBylines,
    ]) {
      if (row.name && !seen.has(row.name)) {
        seen.add(row.name);
        out.push({ id: row.id, name: row.name });
      }
    }
    // The post's own stored byline, if this render did not otherwise produce
    // it. `id: null` because we may genuinely not know its row id (it was
    // filtered out before it reached us) — and a null id is also what stops
    // the manage list offering to retire a row it cannot address.
    if (initialByline && !seen.has(initialByline)) out.push({ id: null, name: initialByline });
    return out;
  }, [bylines, addedBylines, retiredBylineIds, initialByline]);

  /**
   * The byline fragment every save spreads in — ABSENT unless the operator
   * actually moved the picker, exactly like `labelPatch`.
   *
   * The second belt of the same fix. Even if the control were mis-rendered,
   * not writing what nobody touched means a caption-only edit provably cannot
   * rewrite `post.byline`. Only a `stablepass` post ever sends it; the route
   * 400s the key for any other subject.
   */
  const bylinePatch: { byline?: string } =
    subject === "stablepass" && byline !== initialByline && byline.trim() !== ""
      ? // Trimmed, matching what `subjectFields` sends on create. Both routes
        // trim server-side, so this is cosmetic — but two call sites sending
        // the same value two different ways is how a real divergence hides.
        { byline: byline.trim() }
      : {};

  // Add-new form state. `adding` opens the inline field; it is an inline
  // control rather than a `window.prompt` so it can be styled, validated in
  // place, and driven by a test.
  const [adding, setAdding] = useState(false);
  const [newLabel, setNewLabel] = useState("");
  const [addBusy, setAddBusy] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);
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

  /**
   * ENG-824 — poster frame time. Mirror `labelPatch`: ABSENT unless the
   * operator actually picked a frame. createDraft usually runs on file pick
   * (before scrub), so the publish PATCH + the immediate patch on
   * "Use this frame" are how the time reaches the row.
   */
  const [posterTimeS, setPosterTimeS] = useState<number | null>(null);
  const posterTimePatch: PosterTimePatch =
    posterTimeS === null ? {} : { poster_time_s: posterTimeS };

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
  const [photos, setPhotos] = useState<ComposePhoto[]>(() => initialPhotos(initial));
  /**
   * ENG-1266 — the highest upload ordinal this SESSION has ever held for the
   * current post, which is what `afterSlot` must report.
   *
   * Derived from `photos` it would be wrong: removing a tile that is still
   * uploading drops its path from the array but does NOT abort its PUT, so the
   * hint would fall back to a slot whose bytes are still on their way. The
   * route floors the answer at its own derivation, but its floor comes from
   * `post_media` + the mirror + the Storage listing — and an in-flight object
   * is in none of those yet. The next append would then be minted straight
   * onto the live slot and the abandoned PUT would land on top of it: the
   * operator sees the tile they picked and the post shows the one they threw
   * away.
   *
   * So it only ever goes UP, for the life of one post. `-1` means "holding
   * nothing" — NOT `nextPhotoSlot([]) - 1`, which is 0, because `photo-0` is a
   * real ordinal a post can hold and "none" has to be distinguishable from it.
   * (The send site floors at 0 either way; the distinction is for reading the
   * ref, not for the wire.) It is reset only where the POST itself changes
   * (`resetMedia`, a replacing pick) — never by a remove.
   *
   * Seeded from `initial.photos` rather than `initialPhotos(initial)`: a
   * `useRef` initialiser is NOT lazy the way the `useState` one above is, so
   * it re-runs on every render and only the first value is ever kept. The raw
   * paths are all this needs, so there is no reason to rebuild the tiles.
   */
  const highestSlotEverHeld = useRef(
    initial?.photos?.length ? nextPhotoSlot(initial.photos.map((p) => p.path)) - 1 : -1,
  );
  /** Record slots just minted. Monotonic by construction — see the ref. */
  function holdSlots(paths: string[]) {
    highestSlotEverHeld.current = Math.max(highestSlotEverHeld.current, nextPhotoSlot(paths) - 1);
  }
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
  /**
   * ENG-1266 — what the NEXT file-dialog result means.
   *
   * One hidden <input type=file> serves three buttons ("Select file",
   * "Replace all", "Add more photos"), and the dialog result arrives with no
   * memory of which one opened it. A ref rather than state on purpose: it is
   * read inside the change handler in the same tick the click set it, and a
   * state update would not have landed yet.
   */
  const pickMode = useRef<"replace" | "append">("replace");

  /**
   * The post that appended slots are minted against: the draft in create mode,
   * the post being edited otherwise. Null before the first pick has created a
   * draft — there is nothing to append to yet.
   */
  const uploadPostId = draft?.id ?? initial?.id ?? null;

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

  /**
   * ENG-1268 — the trainer search, over the FULL trainer list.
   *
   * Same rule as the horse search it is modelled on (and reuses the classes
   * of): every match, never a slice — the list is scrollable and the roster is
   * small. Matches on the stable name too, because an operator looking for
   * "the Randwick one" is a real way to find a trainer.
   */
  const trainerMatches = useMemo(() => {
    const q = trainerSearch.trim().toLowerCase();
    if (!q) return trainers;
    return trainers.filter(
      (t) =>
        t.name.toLowerCase().includes(q) || (t.stableName ?? "").toLowerCase().includes(q),
    );
  }, [trainers, trainerSearch]);

  /**
   * The type tiles this subject may author (epic decision 2) — StablePass gets
   * Photo and Video, the other two get all four.
   *
   * HIDDEN, not disabled: a disabled Voice tile invites the operator to work
   * out why, and there is no answer they can act on. The server rejects
   * voice/text for a StablePass post regardless, so this is the affordance and
   * never the enforcement.
   */
  const visibleTypes = useMemo(
    () => POST_TYPES.filter((p) => TYPES_BY_SUBJECT[subject].includes(p.type)),
    [subject],
  );

  /**
   * IS THE SUBJECT SATISFIED? — the generalisation of "Pick a horse first."
   *
   * Keyed on the chosen subject's REQUIRED field, which is the whole point of
   * this ticket: the old guard asked for a horse on every post, so a trainer's
   * weekend preview could not attach media at all. The message names the thing
   * that is actually missing, per subject, rather than the horse.
   */
  const subjectReady =
    subject === "horse"
      ? !!horse && !!bylineId
      : subject === "trainer"
        ? !!trainer
        : byline.trim() !== "";
  const SUBJECT_PROMPT: Record<Subject, string> = {
    horse: "Pick a horse first.",
    trainer: "Pick a trainer first.",
    stablepass: "Choose a byline first.",
  };
  const subjectPrompt = SUBJECT_PROMPT[subject];

  /**
   * The create payload's subject fields, in ONE place.
   *
   * Four call sites mint a draft (single pick, multi-photo pick, text, and the
   * create-on-publish path), and each used to spell `horseId` + `sourceTrainerId`
   * out by hand. Three copies of a per-subject rule is how one of them ends up
   * sending a horse id on a trainer post — which the route 400s, but only
   * after the operator has picked their file.
   *
   * A horse post sends NO `subject` key at all, so its request stays
   * byte-identical to the one this endpoint received before this ticket.
   */
  const subjectFields: { subject?: Subject; horseId?: string; sourceTrainerId?: string; byline?: string } =
    subject === "horse"
      ? { horseId: horse?.id, sourceTrainerId: bylineId }
      : subject === "trainer"
        ? { subject: "trainer", sourceTrainerId: trainer?.id }
        : { subject: "stablepass", byline: byline.trim() };

  /**
   * ENG-1268 — the titles that may be retired: non-builtin, not already
   * retired this session. Builtins are absent, which is what "builtin labels
   * show no ×" means for a list-shaped control.
   */
  const retirableLabels = labelActions.filter(
    (l) => !l.isBuiltin && !retiredLabelNames.includes(l.name),
  );
  /** The bylines that may be retired — every row we know an id for. */
  const retirableBylines = bylineOptions.filter(
    (b): b is { id: string; name: string } => b.id !== null,
  );

  const isText = postType === "text";
  /**
   * A photo post outside edit mode always goes through the multi-photo set
   * path — for readiness AND for what gets persisted.
   */
  // ENG-1266 — edit mode now goes through the SAME set path as create. It used
  // to be `&& !isEdit` because editing rendered media read-only, which is half
  // the bug this ticket exists to fix: an operator could not fix a wrong photo
  // on a post that was already created. The consequence of widening it is that
  // an edit save now carries `media`, so the strip is what `post_media` and the
  // `post.media_url` mirror are rewritten from.
  const usesPhotoSet = postType === "photo" && !photosUnavailable;
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
    // `usesPhotoSet`, not `postType === "photo"`: since ENG-1266 edit mode DOES
    // send a set, but a session whose `post_media` read failed must not — that
    // set would delete the rows it never saw (`photosUnavailable`). The length
    // check below is
    // belt-and-braces — `resetMedia()` runs before `setPostType`, so `photos`
    // is already empty for any other type — which is exactly why it is worth
    // stating rather than relying on the ordering of two calls elsewhere.
    usesPhotoSet && readyPhotos.length > 0
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
  // ENG-1268 — `subjectReady`, not `horse && bylineId`: a text post is a
  // trainer's or the brand's to write too. (StablePass never reaches here —
  // Text is not one of its tiles — but the readiness rule must not depend on
  // that, it must depend on the subject being satisfied.)
  const textReady = subjectReady && caption.trim().length > 0;
  /**
   * ENG-1266 — an edit save that would leave a photo post with NO photos.
   *
   * `readyPhotos`, not `photos`: a tile still uploading or failed has no object
   * behind it, so saving with only those would write a `post_media` row (and a
   * mirror) pointing at nothing. Save is disabled rather than the removal being
   * refused, because removing the last photo on the way to replacing it is a
   * legitimate thing to be halfway through.
   */
  const editPhotoEmpty = isEdit && usesPhotoSet && readyPhotos.length === 0;
  /**
   * ENG-1266 — an edit save taken while a photo is still in flight.
   *
   * Create mode gates every action on `photosSettled`; edit mode had no
   * equivalent, so `Save changes` stayed live mid-upload and shipped the DONE
   * tiles only — which `PATCH /posts/:id` implements by deleting the rows
   * above them. The photo the operator is watching upload is dropped and the
   * trailing `post_media` rows go with it, silently.
   *
   * Same rule as `photosSettled`, so the two halves of the screen agree: an
   * UPLOADING tile blocks the save; a FAILED one does not — the documented
   * behaviour is that the post keeps what landed and the strip offers a retry.
   * `editPhotoEmpty` is the stronger statement of the `photos.length === 0`
   * half and is always checked first, so this sentence only ever appears for a
   * strip that genuinely has something in flight.
   */
  const editPhotoUnsettled = isEdit && usesPhotoSet && !photosSettled;
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

  /**
   * ENG-1268 — switch the subject.
   *
   * Everything downstream belongs to the old subject: the draft row was minted
   * with `subject` already set (the route writes it at insert, and PATCH
   * rejects the key), the picked file was uploaded against that draft, and the
   * chosen type may not even exist under the new subject. So this reuses the
   * SAME clear path `chooseType` and the replace-a-file flow use, rather than
   * inventing a second one — and confirms first when there is work to lose,
   * exactly as switching horse does today.
   */
  function chooseSubject(next: Subject) {
    if (next === subject) return;
    // Only ask when there is something to discard. A subject switch before any
    // file is picked is free, and a confirm on it is noise the operator learns
    // to click through — which is how a real confirm stops being read.
    const hasWork = !!draft || photos.length > 0 || !!file;
    if (hasWork && typeof window !== "undefined" && !window.confirm(DISCARD_ON_SUBJECT_SWITCH)) {
      return;
    }
    if (draft) void discardDraft(draft.id).catch(() => {});
    resetMedia();
    // Clear the OTHER subjects' identity fields too. Leaving them set would
    // let a stale horse leak a "Race day" badge onto a trainer post's preview,
    // and would put a horse id in the next create payload the moment the
    // operator switched back and forth.
    setHorse(null);
    setSearch("");
    setShowResults(false);
    setBylineId("");
    setTrainer(null);
    setTrainerSearch("");
    setShowTrainerResults(false);
    setByline("");
    // The type may not exist under the new subject (Voice/Text are not
    // StablePass tiles). Fall back to that subject's FIRST tile rather than
    // leaving a selection no tile shows — an invisible selected type is how a
    // post gets created as something the operator never picked.
    const allowed = TYPES_BY_SUBJECT[next];
    if (!allowed.includes(postType)) setPostType(allowed[0]);
    setSubject(next);
  }

  /** ENG-1268 — the Trainer subject's pick. Mirrors `selectHorse`. */
  function selectTrainer(t: TrainerOption) {
    setTrainer(t);
    setTrainerSearch(t.name);
    setShowTrainerResults(false);
  }

  function changeTrainer() {
    // The draft (if any) was minted against the old trainer — drop it too,
    // exactly as `changeHorse` does.
    if (draft) void discardDraft(draft.id).catch(() => {});
    resetMedia();
    setTrainer(null);
    setTrainerSearch("");
    setShowTrainerResults(true);
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
    // The DRAFT is discarded below, so the next photo belongs to a different
    // post id and no slot of this one is held any more. This is the only kind
    // of place the high-water mark may go down.
    highestSlotEverHeld.current = -1;
    setPhotoError(null);
    setFile(null);
    setMediaUrl(null);
    setDims(null);
    setMeasure("off");
    setPosterTimeS(null);
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

  /**
   * ENG-824 — operator confirmed a poster frame from the local scrubber.
   * Persist immediately when a draft already exists so Mux `asset.ready` can
   * bake the chosen time even if they publish later (or not yet).
   */
  function onPickPosterFrame(timeS: number) {
    setPosterTimeS(timeS);
    if (draft) {
      void patchPost(draft.id, { poster_time_s: timeS }).catch(() => {
        // Best-effort early write — the publish PATCH re-sends posterTimePatch.
      });
    }
  }

  async function onPickFile(picked: File) {
    // ENG-1268 — keyed on the CHOSEN subject's required field, not on a horse.
    // "Pick a horse first." on a trainer's weekend-preview video is the exact
    // block this ticket exists to remove.
    if (!subjectReady) {
      setUpload({ state: "error", pct: 0, error: subjectPrompt });
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
    // A replacement clip invalidates any previous poster pick.
    setPosterTimeS(null);
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
      const created = await createDraft({
        // ENG-1268 — the per-subject fields, derived once (see subjectFields).
        ...subjectFields,
        type: kind,
      });
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
    // ENG-1268 — keyed on the CHOSEN subject's required field, not on a horse.
    // "Pick a horse first." on a trainer's weekend-preview video is the exact
    // block this ticket exists to remove.
    if (!subjectReady) {
      setUpload({ state: "error", pct: 0, error: subjectPrompt });
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
    // A replacing pick mints a BRAND NEW draft below, so nothing of the old
    // post is held. Same exception as `resetMedia`.
    highestSlotEverHeld.current = -1;

    const generation = ++pickGeneration.current;
    const stale = () => pickGeneration.current !== generation;

    try {
      const created = await createDraft({
        ...subjectFields,
        type: "photo",
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
      holdSlots(seeded.map((p) => p.path));

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
   * ENG-1266 — "Add more photos": a pick that APPENDS to the set.
   *
   * The bug this closes: `onPickPhotos` REPLACES, so an operator adding photos
   * one at a time kept throwing the previous one away and ended with a
   * one-photo post (Justin, 19 Sep). Appending needed its own path, and its own
   * upload targets — `createDraft` minted every slot up front from
   * `photoCount`, so there was no way to get another one after the fact.
   *
   * THE GENERATION COUNTER IS READ, NEVER BUMPED. Bumping it is what
   * `resetMedia` / `chooseType` / a replacing pick do to say "everything in
   * flight is void"; an append voids nothing — the tiles already uploading are
   * still wanted, and discarding them is the exact behaviour this ticket is
   * removing. We capture the current value so that a genuine reset DURING an
   * append still stops our own late writes.
   */
  async function onAppendPhotos(picked: File[]) {
    if (picked.length === 0) return;
    const postId = uploadPostId;
    if (!postId) {
      setPhotoError("Add the first photo before adding more.");
      return;
    }

    // The cap, before anything is minted or uploaded — the whole strip counts,
    // including tiles still uploading, because each already holds a slot.
    const capError = appendCapError(photos.length, picked.length);
    if (capError) {
      setPhotoError(capError);
      if (fileInputRef.current) fileInputRef.current.value = "";
      return;
    }

    // Same MIME rule as a replacing pick: never a silent reclassification.
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

    const generation = pickGeneration.current;
    const stale = () => pickGeneration.current !== generation;

    let targets: PhotoUploadTarget[];
    try {
      targets = await requestPhotoUploads(postId, picked.length, {
        // What the server cannot see: slots this strip already holds whose
        // bytes have not landed (still uploading, or failed and awaiting a
        // retry). Without this the route would re-issue one of them and the
        // new upload would overwrite a photo the operator is still waiting on.
        //
        // The HIGH-WATER MARK, not `photos` — a tile removed mid-upload is
        // gone from the array but its PUT is still in flight, so deriving the
        // hint from the survivors would hand back a live slot. See the ref.
        afterSlot: Math.max(0, highestSlotEverHeld.current),
        // What the operator will keep. The server would otherwise count the
        // orphaned objects of photos they removed (left in Storage by design)
        // and refuse a legitimate append.
        keeping: photos.length,
      });
    } catch (e) {
      if (stale()) return;
      setPhotoError((e as Error).message);
      return;
    }
    if (stale()) return;
    // Partial sets are refused outright: uploading 2 of 3 would leave the
    // operator looking at a strip that quietly lost a file they picked.
    if (targets.length < picked.length) {
      setPhotoError("Storage did not return enough upload slots. Nothing was uploaded.");
      return;
    }

    const added: ComposePhoto[] = picked.map((f, i) => ({
      // Keyed by the slot PATH, which the route guarantees is new — an index
      // key would collide with the tiles already in the strip.
      id: `${postId}-${targets[i].path}`,
      path: targets[i].path,
      previewUrl: objectUrl(f),
      name: f.name,
      size: f.size,
      state: "uploading",
      file: f,
      bucket: targets[i].bucket,
      token: targets[i].token,
    }));
    setPhotos((prev) => appendPhotos(prev, added));
    holdSlots(added.map((p) => p.path));

    // Sequential, matching the create path: ten parallel PUTs from one browser
    // is what makes the slowest time out. Each tile settles on its own, so one
    // failure leaves the rest of the append — and the whole existing set —
    // untouched.
    for (let i = 0; i < picked.length; i++) {
      const target = targets[i];
      try {
        await uploadPhotoToStorage({
          bucket: target.bucket,
          path: target.path,
          token: target.token,
          file: picked[i],
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
      if (!subjectReady) {
        setAction({ kind: "error", message: subjectPrompt });
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
          ...subjectFields,
          type: postType,
          body: caption,
          ...labelPatch,
          ...posterTimePatch,
        });
        setDraft(current);
      }

      // Persist the editable byline + caption before the lifecycle action.
      // ENG-979: `title` is NOT sent. It has no input any more, and an absent
      // key leaves the column alone — which is what preserves the titles on
      // posts written before this ticket.
      await patchPost(current.id, {
        body: caption,
        // ENG-1268 — the editable byline, and ONLY for a horse post. A
        // trainer post's trainer IS its subject and is immutable (the route
        // 400s it); a StablePass post has no trainer at all and carries
        // `bylinePatch` instead.
        ...(subject === "horse" ? { sourceTrainerId: bylineId } : {}),
        ...bylinePatch,
        ...labelPatch,
        ...mediaPatch,
        ...posterTimePatch,
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
      setCaption("");
      setAction({ kind: "ok", message: "Draft discarded." });
    } catch (e) {
      setAction({ kind: "error", message: (e as Error).message });
    }
  }

  /**
   * ENG-979 — Add-new: create the category and select it, in one interaction.
   *
   * The route is idempotent by folded name, so retyping an existing category
   * (differing only in case or spacing) selects the row that already exists
   * instead of erroring or creating a second one. We therefore select
   * `created.name` — the row's CANONICAL spelling — rather than what was typed:
   * an operator who types "trackwork" ends up on "Trackwork", which is the
   * value `post.label`'s foreign key will accept.
   */
  async function submitNewLabel() {
    const name = newLabel.trim().replace(/\s+/g, " ");
    if (name === "") {
      setAddError("Give the label a name.");
      return;
    }
    if (name.length > MAX_LABEL_LENGTH) {
      setAddError(`Keep it to ${MAX_LABEL_LENGTH} characters or fewer.`);
      return;
    }
    setAddBusy(true);
    setAddError(null);
    try {
      const createdLabel = await createPostLabel(name);
      setAddedLabels((prev) =>
        prev.includes(createdLabel.name) ? prev : [...prev, createdLabel.name],
      );
      setLabel(createdLabel.name);
      setNewLabel("");
      setAdding(false);
    } catch (e) {
      // Stay open with the typed value intact — guardrail 6 rejections and
      // over-length names are both fixable in place, and closing the field
      // would throw away what they wrote.
      setAddError((e as Error).message || "Couldn’t add that label.");
    } finally {
      setAddBusy(false);
    }
  }

  /**
   * ENG-1268 — Add-new for the StablePass byline. Mirrors `submitNewLabel`.
   *
   * ONE CONTRACT DIFFERENCE, and it matters here: A2 made a live duplicate a
   * 409 rather than idempotent, while a duplicate whose only row is RETIRED is
   * un-retired and returned with its ORIGINAL id. So we take the id back off
   * the response instead of assuming a new row, and we clear that id from
   * `retiredBylineIds` — otherwise a byline the operator retired and
   * immediately re-added this session would be filtered straight back out of
   * the picker they just added it to.
   */
  async function submitNewByline() {
    const name = newByline.trim().replace(/\s+/g, " ");
    if (name === "") {
      setBylineAddError("Give the byline a name.");
      return;
    }
    if (name.length > MAX_BYLINE_LENGTH) {
      setBylineAddError(`Keep it to ${MAX_BYLINE_LENGTH} characters or fewer.`);
      return;
    }
    setBylineAddBusy(true);
    setBylineAddError(null);
    try {
      const createdByline = await createByline(name);
      setRetiredBylineIds((prev) => prev.filter((id) => id !== createdByline.id));
      setAddedBylines((prev) =>
        prev.some((b) => b.id === createdByline.id) ? prev : [...prev, createdByline],
      );
      // The row's CANONICAL spelling, not what was typed — that is the string
      // `post.byline`'s foreign key will accept.
      setByline(createdByline.name);
      setNewByline("");
      setAddingByline(false);
    } catch (e) {
      // Stay open with the typed value intact: a 409 ("that name is taken")
      // and a guardrail-6 rejection are both fixable right here.
      setBylineAddError((e as Error).message || "Couldn’t add that byline.");
    } finally {
      setBylineAddBusy(false);
    }
  }

  /**
   * ENG-1268 — retire a title or a byline from its picker.
   *
   * RETIRE, NOT DELETE, and the confirm says so in as many words: posts
   * already using the name keep it. That is not reassurance, it is the actual
   * behaviour — `post.label` / `post.byline` store the NAME and retiring only
   * stamps `retired_at` on the lookup row.
   *
   * The optimistic removal is by NAME for a label and by ID for a byline,
   * matching what each picker's option list is keyed on. Neither ever removes
   * the value the post being edited carries: `options` and `bylineOptions`
   * append that back after the filter, so retiring the title you are currently
   * using cannot blank the post in front of you.
   *
   * ENG-1290 — but that union-back covers exactly ONE value: the edited post's
   * own `initial.label` / `initial.byline`. It is not a general guarantee, and
   * it does not exist at all in CREATE mode. Every other selected value left
   * pointing at a row that was just retired would keep the `<select>` blank
   * while state still held the name, so the clear below handles them.
   */
  async function onRetire(kind: "label" | "byline", row: { id: string; name: string }) {
    const message = `Remove “${row.name}” from the list? Posts already using it keep it.`;
    if (typeof window !== "undefined" && !window.confirm(message)) return;
    setRetiringId(row.id);
    setRetireError(null);
    try {
      if (kind === "label") {
        await retireLabel(row.id);
        setRetiredLabelNames((prev) => (prev.includes(row.name) ? prev : [...prev, row.name]));
      } else {
        await retireByline(row.id);
        setRetiredBylineIds((prev) => (prev.includes(row.id) ? prev : [...prev, row.id]));
        setAddedBylines((prev) => prev.filter((b) => b.id !== row.id));
      }
      // ENG-1290 — clear the selection when the row just retired IS the one
      // selected AND nothing will union it back. Without this the <select>
      // loses its matching <option> and renders blank while `label` / `byline`
      // state still holds the name: `subjectReady` stays true (`byline.trim()
      // !== ""`) and the first save 400s with `unknown_byline` against a picker
      // that looks empty — a dead end the operator cannot diagnose.
      //
      // The guard is `!== initialByline` / `!== initialLabel`, NOT `!isEdit`,
      // and the difference is load-bearing (pinned by the edit-mode tests),
      // because that is exactly the condition the union belt above keys on:
      // `bylineOptions` / `options` re-append the EDITED post's own value after
      // the retired filter, so that one value stays selectable and must NOT be
      // cleared (the "cannot blank the post in front of you" invariant, pinned
      // by the edit-mode tests). Every other selected value — all of create
      // mode, and an edit-mode operator who picked a different row before
      // retiring it — has no union-back and does need clearing.
      // Functional updaters, like every other setter in this block: `byline` /
      // `label` here would be the values captured BEFORE the `await` above,
      // and neither <select> is disabled while the retire is in flight. An
      // operator who moves the picker mid-request would otherwise either have
      // their fresh choice wiped (stale value still matched `row.name`) or be
      // left on the row that was just retired (stale value did not match) —
      // the second being the very dead end this fix closes.
      //
      // The fallback is the post's OWN value, not "": in create mode
      // `initial*` is "" so this IS a clear, while in edit mode snapping back
      // to `initialLabel` / `initialByline` keeps the control honest about the
      // post in front of the operator. Clearing to "" there would be worse
      // than cosmetic — `labelPatch` sends `label: null` for "", so the next
      // save would quietly UN-TITLE a post whose title was never touched.
      if (kind === "byline") {
        setByline((prev) => (prev === row.name && row.name !== initialByline ? initialByline : prev));
      }
      if (kind === "label") {
        setLabel((prev) => (prev === row.name && row.name !== initialLabel ? initialLabel : prev));
      }
    } catch (e) {
      // Nothing is removed from the picker on failure — the row is still live
      // server-side, and hiding it here would offer the operator a list that
      // disagrees with what a save will accept.
      setRetireError((e as Error).message || `Couldn’t remove “${row.name}”.`);
    } finally {
      setRetiringId(null);
    }
  }

  // Edit mode: PATCH the editable fields (caption + byline) on the existing
  // post — horse and media are fixed here (the PATCH contract covers neither).
  async function saveEdit() {
    if (!initial) return;
    // ENG-1266 — never save a photo post down to nothing. The button is already
    // disabled for this, but the guard stays: `mediaPatch` omits the key when
    // the set is empty, so without it a save would silently keep the old photos
    // while the operator watched an empty strip and believed they were gone.
    if (editPhotoEmpty) {
      setAction({ kind: "error", message: PHOTO_REQUIRED });
      return;
    }
    // ENG-1266 — and never save one down to the tiles that happen to have
    // landed: the set we would send omits the in-flight photo, and the PATCH
    // deletes every row above it. The button is disabled for this too.
    if (editPhotoUnsettled) {
      setAction({ kind: "error", message: PHOTO_UPLOADING });
      return;
    }
    setAction({ kind: "working" });
    try {
      await patchPost(initial.id, {
        body: caption,
        // ENG-1268 — the editable byline, and ONLY for a horse post. A
        // trainer post's trainer IS its subject and is immutable (the route
        // 400s it); a StablePass post has no trainer at all and carries
        // `bylinePatch` instead.
        ...(subject === "horse" ? { sourceTrainerId: bylineId } : {}),
        ...bylinePatch,
        ...labelPatch,
        ...mediaPatch,
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
    if (editPhotoEmpty) {
      setAction({ kind: "error", message: PHOTO_REQUIRED });
      return;
    }
    // ENG-1266 — and never save one down to the tiles that happen to have
    // landed: the set we would send omits the in-flight photo, and the PATCH
    // deletes every row above it. The button is disabled for this too.
    if (editPhotoUnsettled) {
      setAction({ kind: "error", message: PHOTO_UPLOADING });
      return;
    }
    setAction({ kind: "working" });
    try {
      await patchPost(initial.id, {
        body: caption,
        // ENG-1268 — the editable byline, and ONLY for a horse post. A
        // trainer post's trainer IS its subject and is immutable (the route
        // 400s it); a StablePass post has no trainer at all and carries
        // `bylinePatch` instead.
        ...(subject === "horse" ? { sourceTrainerId: bylineId } : {}),
        ...bylinePatch,
        ...labelPatch,
        ...mediaPatch,
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
    if (editPhotoEmpty) {
      setAction({ kind: "error", message: PHOTO_REQUIRED });
      return;
    }
    // ENG-1266 — and never save one down to the tiles that happen to have
    // landed: the set we would send omits the in-flight photo, and the PATCH
    // deletes every row above it. The button is disabled for this too.
    if (editPhotoUnsettled) {
      setAction({ kind: "error", message: PHOTO_UPLOADING });
      return;
    }
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
        body: caption,
        // ENG-1268 — the editable byline, and ONLY for a horse post. A
        // trainer post's trainer IS its subject and is immutable (the route
        // 400s it); a StablePass post has no trainer at all and carries
        // `bylinePatch` instead.
        ...(subject === "horse" ? { sourceTrainerId: bylineId } : {}),
        ...bylinePatch,
        ...labelPatch,
        ...mediaPatch,
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
    // ENG-1268 — the head follows the subject. The preview is the only place
    // the operator sees what a member will get, so a StablePass post that
    // previewed a horse head would be the ENG-558 lie in a new place.
    subject,
    horseName: horse?.name ?? null,
    // The attribution line, whose meaning follows the subject (see
    // PostPreviewData.byline): the byline TRAINER for a horse post, and the
    // chosen `post_byline` name for a StablePass one. A trainer post takes
    // neither — its head is the trainer.
    byline: subject === "stablepass" ? byline || null : subject === "trainer" ? null : trainerName,
    trainer: trainer
      ? {
          name: trainer.name,
          photoUrl: trainer.photoUrl,
          subline: trainerSubline(trainer),
        }
      : null,
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
    // ENG-748 (C1, found in review) — the carousel shows the photos that will
    // actually BE THERE: `readyPhotos`, never the raw list.
    //
    // Built from `photos` it counted still-uploading and FAILED tiles, so two
    // picks with one failure drew "1/2" and two dots for a post that persists a
    // single post_media row — which ENG-740 says must render exactly like a
    // one-photo post, with no dots and no pager. Worse, `PostPreview` uses
    // `gallery[index]` in preference to `mediaUrl`, so the card opened on the
    // FAILED photo while the strip's Cover badge and the Step 3 frame both
    // correctly showed another one. Three surfaces, two answers — the same bug
    // the Step 3 frame fix killed, left alive one component over.
    //
    // No `.filter(Boolean)`: a null previewUrl would silently reindex the
    // gallery against the strip. `readyPhotos` all have one.
    photos:
      postType === "photo" && readyPhotos.length > 1
        ? readyPhotos.map((p) => p.previewUrl ?? "")
        : undefined,
    // Real race-day data off the picked horse — the badge used to be hardcoded
    // on every post, which made the preview claim a race that wasn't running.
    racesToday: horse?.racesToday ?? false,
    /**
     * ENG-769 — the picked label, so the card can draw the pill a member will
     * actually see, and say so when a reel means they will not.
     *
     * DELIBERATE SURFACE WIDENING, called out on the ticket and in the PR:
     * ENG-769 lists this file as do-not-touch, and its scope was written
     * believing the preview already showed the label ("an operator can pick a
     * label ... see it in the preview"). It never did — ENG-745 wired the
     * picker to the BFF and to nothing else, so `previewData` had no `label`
     * at all. Two of the ticket's acceptance criteria are unreachable without
     * this one line, so it is here rather than silently unmet. Nothing else in
     * this file is touched and no in-flight ticket claims it.
     *
     * "" is the picker's "No label" option; the card takes null for that.
     */
    label: label || null,
    dims,
    measure,
  };

  const primaryLabel =
    mode === "publish" ? "Publish now" : mode === "schedule" ? "Schedule" : "Save as draft";
  // Counts what will be PUBLISHED (uploaded), not what was picked — and says so
  // when they differ, so a failed upload is visible in the rail rather than
  // inflating the count (ENG-748 C1).
  const mediaLabel = isText
    ? "None — text post"
    : photos.length > 0
      ? readyPhotos.length === photos.length
        ? readyPhotos.length === 1
          ? "1 photo"
          : `${readyPhotos.length} photos`
        : `${readyPhotos.length} of ${photos.length} photos`
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
                disabled={busy || editPhotoEmpty || editPhotoUnsettled}
              >
                {busy ? "Saving…" : "Save changes"}
              </button>
              {initial?.status === "draft" && (
                <button
                  type="button"
                  className={`btn btn-primary ${styles.btnSm}`}
                  data-testid="publish-draft"
                  onClick={publishDraftNow}
                  disabled={busy || editPhotoEmpty || editPhotoUnsettled}
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
            {/* STEP 1 — SUBJECT (ENG-1268; copy revised by ENG-1297).
                Three segmented options in the Step 2 type-tile language (the
                ticket's design instruction: reuse, no new mockup), then the
                chosen subject's own control below them. */}
            <section className={styles.section}>
              <div className={styles.stepLabel}>Step 1 · Subject</div>
              <h3 className={styles.sectionTitle}>Posted as</h3>

              {isEdit ? (
                // Edit mode: the subject is FIXED, shown rather than picked —
                // the same `type-fixed` treatment the post type has. PATCH
                // rejects a `subject` key, and changing it would strand the
                // asset already uploaded against this post.
                <div className={styles.readOnlyRow} data-testid="subject-fixed">
                  <span className={styles.readOnlyValue}>{SUBJECT_LABEL[subject]}</span>
                  <span className={styles.help}>
                    Who a post is from can&apos;t be changed after it is created.
                  </span>
                </div>
              ) : (
                <div
                  className={styles.subjectPicker}
                  role="radiogroup"
                  aria-label="Posting as"
                  data-testid="subject-picker"
                >
                  {SUBJECTS.map((s) => (
                    <label
                      key={s}
                      className={`${styles.typeOption} ${subject === s ? styles.typeOptionSelected : ""}`}
                      data-testid={`subject-option-${s}`}
                      data-selected={subject === s ? "true" : undefined}
                    >
                      <input
                        type="radio"
                        name="post-subject"
                        value={s}
                        checked={subject === s}
                        onChange={() => chooseSubject(s)}
                      />
                      {SUBJECT_LABEL[s]}
                    </label>
                  ))}
                </div>
              )}

              {/* --- HORSE subject: today's search, unchanged ----------- */}
              {subject === "horse" ? (
                <>
              <label className={styles.label} htmlFor="horse-search" style={{ marginTop: 14 }}>
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
                </>
              ) : null}

              {/* --- TRAINER subject (ENG-1268) ------------------------
                  The same search control as the horse picker, over the full
                  trainer list, with the same result-row classes — the ticket's
                  instruction, and it means the two pickers cannot drift into
                  two different ways of choosing a subject.

                  GUARDRAIL 3: the row prints name + `stable · location` and
                  nothing else. `trainer_contact` is not loaded, not typed and
                  not rendered — see data.ts's TrainerRow. */}
              {subject === "trainer" ? (
                <>
                  <label className={styles.label} htmlFor="trainer-search" style={{ marginTop: 14 }}>
                    Trainer
                  </label>
                  <div className={styles.searchWrap}>
                    {!isEdit ? (
                      <input
                        id="trainer-search"
                        className={styles.input}
                        type="text"
                        placeholder="Search trainers by name or stable…"
                        value={trainerSearch}
                        autoComplete="off"
                        data-testid="trainer-search"
                        onChange={(e) => {
                          setTrainerSearch(e.target.value);
                          setShowTrainerResults(true);
                          if (trainer && e.target.value !== trainer.name) setTrainer(null);
                        }}
                        onFocus={() => setShowTrainerResults(true)}
                      />
                    ) : null}
                    {showTrainerResults && !trainer ? (
                      <ul className={styles.results} data-testid="trainer-results">
                        {trainerMatches.length === 0 ? (
                          <li className={styles.noResults}>
                            No trainers match “{trainerSearch}”.
                          </li>
                        ) : (
                          trainerMatches.map((t) => (
                            <li key={t.id}>
                              <button
                                type="button"
                                className={styles.resultRow}
                                data-testid={`trainer-opt-${t.id}`}
                                onClick={() => selectTrainer(t)}
                              >
                                <span className={styles.resultThumb}>
                                  {t.photoUrl ? (
                                    /* Lazy for the same reason the horse rows
                                       are: this is the whole roster in a 260px
                                       scroll box, so eager loading would fire a
                                       signed-URL request per trainer the moment
                                       the picker opens. The directive must stay
                                       on the line directly above the <img>. */
                                    // eslint-disable-next-line @next/next/no-img-element -- remote trainer thumb, fixed box
                                    <img src={t.photoUrl} alt="" loading="lazy" />
                                  ) : null}
                                </span>
                                <span>
                                  <span className={styles.resultName}>{t.name}</span>
                                  <span className={styles.resultSub}>
                                    {trainerSubline(t) || "no stable set"}
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
                    The post is from the trainer, with no horse attached — for a stable update or a
                    weekend preview that isn&apos;t about one horse.
                  </div>

                  {trainer ? (
                    <div
                      className={styles.horsePick}
                      style={{ marginTop: 12 }}
                      data-testid="trainer-pick"
                    >
                      <div className={`${styles.pickThumb} ${styles.pickThumbRound}`}>
                        {trainer.photoUrl ? (
                          // eslint-disable-next-line @next/next/no-img-element -- remote trainer photo, fixed box
                          <img src={trainer.photoUrl} alt="" />
                        ) : (
                          (trainer.name.trim()[0] ?? "T").toUpperCase()
                        )}
                      </div>
                      <div className={styles.pickMeta}>
                        <p className={styles.pickName}>{trainer.name}</p>
                        <div className={styles.pickSub}>
                          {trainerSubline(trainer) || "no stable set"}
                          {!isEdit ? (
                            <button
                              type="button"
                              className={styles.changeLink}
                              onClick={changeTrainer}
                            >
                              Change trainer
                            </button>
                          ) : null}
                        </div>
                      </div>
                    </div>
                  ) : null}
                </>
              ) : null}

              {/* --- STABLEPASS subject (ENG-1268) ---------------------
                  No horse and no trainer: the post is from the brand, and the
                  BYLINE is what says where it came from. The dropdown is the
                  label dropdown's control, down to the "+ Add new…" sentinel
                  and the inline field — again the ticket's instruction, and
                  again so the two cannot drift. */}
              {subject === "stablepass" ? (
                <>
                  <label className={styles.label} htmlFor="post-byline" style={{ marginTop: 14 }}>
                    Byline
                  </label>
                  <select
                    id="post-byline"
                    className={styles.select}
                    value={byline}
                    data-testid="byline-name-select"
                    // Read-only in edit mode ONLY when the value is one we
                    // could not otherwise offer — see the retired-byline note
                    // on `bylineOptions`. Normally it stays editable: PATCH
                    // accepts `byline` for a stablepass post.
                    onChange={(e) => {
                      const v = e.target.value;
                      if (v === ADD_NEW_BYLINE_VALUE) {
                        setAddingByline(true);
                        setBylineAddError(null);
                        return;
                      }
                      setByline(v);
                    }}
                    style={{ marginBottom: addingByline ? 8 : 6 }}
                  >
                    {/* Disabled placeholder, unlike the label picker's "No
                        label": a byline is REQUIRED for a StablePass post
                        (the route 400s without one), so "none" is not a state
                        the operator may choose. */}
                    <option value="" disabled>
                      Choose a byline…
                    </option>
                    {bylineOptions.map((b) => (
                      <option key={b.name} value={b.name}>
                        {b.name}
                      </option>
                    ))}
                    <option value={ADD_NEW_BYLINE_VALUE}>+ Add new…</option>
                  </select>

                  {addingByline ? (
                    <div className={styles.addLabelRow} data-testid="add-byline-row">
                      <input
                        className={styles.input}
                        type="text"
                        value={newByline}
                        autoFocus
                        maxLength={MAX_BYLINE_LENGTH}
                        data-testid="new-byline-input"
                        aria-label="New byline"
                        placeholder="Name the new byline…"
                        onChange={(e) => setNewByline(e.target.value)}
                        onKeyDown={(e) => {
                          // Enter submits. Without this the field sits inside
                          // the compose form and Enter would fire the primary
                          // action, publishing a post still being named.
                          if (e.key === "Enter") {
                            e.preventDefault();
                            void submitNewByline();
                          }
                          if (e.key === "Escape") {
                            setAddingByline(false);
                            setBylineAddError(null);
                          }
                        }}
                      />
                      <button
                        type="button"
                        className="btn btn-primary"
                        disabled={bylineAddBusy}
                        data-testid="add-byline-save"
                        onClick={() => void submitNewByline()}
                      >
                        {bylineAddBusy ? "Adding…" : "Add"}
                      </button>
                      <button
                        type="button"
                        className="btn btn-light"
                        data-testid="add-byline-cancel"
                        onClick={() => {
                          setAddingByline(false);
                          setBylineAddError(null);
                        }}
                      >
                        Cancel
                      </button>
                    </div>
                  ) : null}
                  {bylineAddError ? (
                    <div className={styles.addLabelError} role="alert" data-testid="add-byline-error">
                      {bylineAddError}
                    </div>
                  ) : null}

                  <ManageList
                    kind="byline"
                    rows={retirableBylines}
                    open={manageBylines}
                    onToggle={() => setManageBylines((v) => !v)}
                    retiringId={retiringId}
                    onRetire={(row) => void onRetire("byline", row)}
                  />

                  <div className={styles.help}>
                    Posted as stablepass, with no horse or trainer attached. The byline is what
                    members see under the name.
                  </div>
                </>
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
                  /* ENG-1268 — the track count follows the number of tiles
                     this subject actually offers. The rule's `repeat(4, 1fr)`
                     would leave StablePass's two tiles at quarter width with
                     two empty columns beside them, which reads as a broken
                     control rather than a shorter one. */
                  style={{ gridTemplateColumns: `repeat(${visibleTypes.length}, 1fr)` }}
                >
                  {visibleTypes.map(({ type, icon }) => (
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
                  {subject === "stablepass"
                    ? // The tiles are HIDDEN for this subject, so the operator
                      // is told why rather than left to notice two are missing.
                      "A StablePass post carries media: photo or video only."
                    : "Text posts have no media: the title and body are the whole post, and they render as a Stable update in the app."}
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
                // ENG-748 multi-select for PHOTO, and since ENG-1266 in EDIT
                // mode too — media is no longer read-only there. Video is a
                // single Mux asset and voice a single Storage object, so
                // neither may offer it.
                multiple={usesPhotoSet}
                data-testid="media-input"
                onChange={(e) => {
                  const picked = Array.from(e.target.files ?? []);
                  // Read and immediately disarm: the next dialog is a replace
                  // unless a button says otherwise, so a stray pick can never
                  // inherit the last one's intent.
                  const mode = pickMode.current;
                  pickMode.current = "replace";
                  if (picked.length === 0) return;
                  // A photo post always goes through the set path, even for one
                  // file — one code path, so the single-photo case cannot drift
                  // away from the multi one. In edit mode there is no replacing
                  // pick at all: the post's photos are the set, and the only
                  // way to add to them is to append.
                  if (usesPhotoSet) {
                    if (mode === "append" || isEdit) void onAppendPhotos(picked);
                    else void onPickPhotos(picked);
                  } else if (!isEdit) void onPickFile(picked[0]);
                }}
              />

              {isEdit ? (
                <div className={`${styles.uploadZone} ${styles.filled}`} data-testid="media-existing">
                  <div
                    className={`${styles.preview} ${postType === "voice" ? styles.previewAudio : ""}`}
                  >
                    {postType === "photo" && (coverPhoto?.previewUrl ?? mediaUrl) ? (
                      // ENG-1266 — the COVER of the (now editable) set, which
                      // is not necessarily the photo this post opened with:
                      // reordering moves it, and `post.media_url` follows.
                      // eslint-disable-next-line @next/next/no-img-element -- signed existing media
                      <img src={coverPhoto?.previewUrl ?? mediaUrl!} alt="" />
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
                      {usesPhotoSet
                        ? // ENG-1266 — they CAN be changed now, so the old
                          // sentence would be a straight lie. The strip below
                          // carries the controls.
                          `${photos.length} ${photos.length === 1 ? "photo" : "photos"} \u00b7 add, remove or reorder them below.`
                        : photosUnavailable
                          ? // Honest about WHY, so the operator retries instead
                            // of concluding the photos are gone.
                            "This post\u2019s photos couldn\u2019t be loaded, so they can\u2019t be edited right now. Reload to try again \u2014 your other changes still save."
                          : `Existing ${postType} \u00b7 media can\u2019t be changed when editing.`}
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
                      <button
                        type="button"
                        className={styles.uploadBtn}
                        onClick={() => {
                          // ENG-1266 — ARM the intent here rather than relying on
                          // the change handler having disarmed the last one. A
                          // CANCELLED dialog fires no `change` event, so an
                          // "Add more photos" click the operator then escaped
                          // would leave the ref on "append" and turn this
                          // Replace into an append.
                          pickMode.current = "replace";
                          fileInputRef.current?.click();
                        }}
                      >
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
                      onClick={() => {
                        // Armed here for the same reason as Replace above: a
                        // cancelled Add-more dialog must not make the first pick
                        // an append.
                        pickMode.current = "replace";
                        fileInputRef.current?.click();
                      }}
                      disabled={!subjectReady}
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
              {/* ENG-824 — local poster scrubber. Video create only; never edit
                  mode (media is fixed there) and never photo/text/voice.
                  needs-design-check: no mockup — matches Step 3 upload controls. */}
              {!isEdit && postType === "video" && file && mediaUrl ? (
                <PosterScrubber
                  key={mediaUrl}
                  file={file}
                  src={mediaUrl}
                  selectedTimeS={posterTimeS}
                  onPick={onPickPosterFrame}
                />
              ) : null}
              {/* ENG-748 — the ordering strip. Present only for a photo post
                  that actually has photos, and only outside edit mode (media is
                  read-only there). Deliberately rendered for a ONE-photo set
                  too: the tile is where "Add more" and the upload state live,
                  and hiding it until a second photo appears would mean the
                  single-photo operator never sees either.

                  Up/down buttons, not drag — resolved open question, v1. */}
              {usesPhotoSet && (isEdit || photos.length > 0) ? (
                <>
                  <div className={styles.photoStrip} data-testid="photo-strip">
                    {photos.map((p, i) => (
                      <div
                        key={p.id}
                        className={`${styles.photoTile} ${p.state === "error" ? styles.photoTileBad : ""}`}
                        data-testid={`photo-tile-${i}`}
                        // A stable per-photo identity that exists even when
                        // there is no object URL to render an <img> from —
                        // jsdom has no URL.createObjectURL, so a test that reads
                        // display order off `img src` compares empty strings and
                        // proves nothing (ENG-748 C2).
                        data-photo-path={p.path}
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
                            // A photo loaded from the post has no File behind
                            // it, so there is no size to print — "saved" is the
                            // honest word for "this one is already in Storage".
                            p.size > 0 ? humanSize(p.size) : "saved"
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
                  {/* ENG-1266 — the control the whole ticket is about. Styled
                      with the screen's existing small light button (the same
                      `.btnLight .btnSm` pairing as Step 3's "Select file"),
                      because the 03-compose mockup predates multi-photo and
                      draws no Add-more affordance — client decision: follow the
                      existing design rather than invent one.

                      Sits BELOW the strip, so the strip stays a pure row of
                      tiles in display order and the button does not read as an
                      eleventh position. */}
                  <div className={styles.photoStripActions}>
                    <button
                      type="button"
                      className={`btn ${styles.btnLight} ${styles.btnSm}`}
                      data-testid="photo-add-more"
                      // Deliberately NOT disabled while an earlier batch is
                      // still uploading: appending mid-upload is allowed and
                      // the earlier tiles are unaffected.
                      disabled={!uploadPostId || photos.length >= MAX_PHOTOS}
                      onClick={() => {
                        pickMode.current = "append";
                        if (fileInputRef.current) {
                          // Clear first: picking the SAME file again fires no
                          // change event while the input still holds it.
                          fileInputRef.current.value = "";
                          fileInputRef.current.click();
                        }
                      }}
                    >
                      Add more photos
                    </button>
                    <span className={styles.help} data-testid="photo-strip-help">
                      {photos.length >= MAX_PHOTOS
                        ? `That is the maximum of ${MAX_PHOTOS} photos.`
                        : readyPhotos.length === photos.length
                          ? `${photos.length} of ${MAX_PHOTOS} photos.`
                          : `${readyPhotos.length} of ${photos.length} uploaded (max ${MAX_PHOTOS}).`}{" "}
                      The first uploaded photo is the cover — it is what the feed and the member card
                      show.
                    </span>
                  </div>
                  {/* Removing the last photo is a legitimate step on the way to
                      replacing it, so it is allowed — but the post cannot be
                      SAVED in that state, and the sentence says so where the
                      operator just made it true. */}
                  {editPhotoEmpty ? (
                    <div
                      className={`${styles.help} ${styles.uploadError}`}
                      data-testid="photo-none"
                      role="alert"
                    >
                      {PHOTO_REQUIRED}
                    </div>
                  ) : null}
                  {/* Same place, same voice, for the other state the post
                      cannot be saved in. Not `uploadError` — nothing has gone
                      wrong, the tiles are simply still working, so it reads as
                      help text rather than a failure. `editPhotoEmpty` wins
                      when both are true: "there are none" is the more useful
                      sentence than "one is still coming". */}
                  {editPhotoUnsettled && !editPhotoEmpty ? (
                    <div className={styles.help} data-testid="photo-uploading" role="status">
                      {PHOTO_UPLOADING}
                    </div>
                  ) : null}
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

              {/* THE EDITABLE TRAINER BYLINE — HORSE POSTS ONLY (ENG-1268).
                  A horse post is attributed TO a trainer, and which one is an
                  editorial choice (it defaults to the horse's stable trainer
                  but need not stay there). The other two subjects have no such
                  choice to make: a trainer post's trainer IS its subject and is
                  immutable, and a StablePass post has no trainer at all — its
                  attribution is the Byline chosen in Step 1. Rendering this
                  control for them would offer an edit the route rejects. */}
              {subject === "horse" ? (
                <>
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
                </>
              ) : (
                // The attribution this post will actually carry, shown where
                // the operator expects to find it — read-only, because it is
                // set in Step 1 and this is Step 4.
                <div className={styles.readOnlyRow} style={{ marginBottom: 14 }}>
                  <label className={styles.label}>Byline</label>
                  <span className={styles.readOnlyValue} data-testid="byline-fixed">
                    {subject === "trainer"
                      ? trainer?.name ?? "No trainer chosen yet"
                      : byline || "No byline chosen yet"}
                  </span>
                  <span className={styles.help}>
                    {subject === "trainer"
                      ? "A trainer post is from the trainer you chose in Step 1."
                      : `Posted as ${STABLEPASS_HANDLE}, with this byline underneath.`}
                  </span>
                </div>
              )}

              {/*
                ENG-979 — ONE field where there were two.

                It used to be a free-text "Title" input AND a "Label" <select>,
                and that pairing is what sent Mel to this ticket: she typed her
                own title, the Posts library still said "Untitled post" (it read
                the label), and she could not tell her posts apart without
                opening each one. Justin: "You only need one. You need a label
                or a title, whatever you want to call it. And the ability to
                make your own." Mel chose the name: "I guess just call it title,
                because that's what the title is."

                So the CONTROL is the label picker (the value goes to
                `post.label`, which is what the library and the member pill
                render) and the WORD is "Title", which is what an operator
                thinks they are setting. The free-text input is gone; the post
                title column stays in the schema but has no input behind it any
                more.

                Still a <select> rather than a pill row: at 14+ categories a
                pill row wraps to three lines and swamps the section, and this
                matches the Trainer byline control directly above it — the
                metadata section's established language.

                "No label" stays a real, selectable option, not a disabled
                placeholder: clearing a category is something an operator must
                be able to do, and it is the state every pre-2026-08-19 post is
                already in.
              */}
              <label className={styles.label} htmlFor="post-label">
                Title
              </label>
              <select
                id="post-label"
                className={styles.select}
                value={label}
                data-testid="label-select"
                onChange={(e) => {
                  const v = e.target.value;
                  // The sentinel is an ACTION, not a value: it opens the
                  // inline field and must never reach `label` state, or a save
                  // would try to write "__add__" to post.label.
                  if (v === ADD_NEW_VALUE) {
                    setAdding(true);
                    setAddError(null);
                    return;
                  }
                  setLabel(v);
                }}
                style={{ marginBottom: adding ? 8 : 14 }}
              >
                <option value="">No title</option>
                {options.map((name) => (
                  <option key={name} value={name}>
                    {name}
                  </option>
                ))}
                {/* Mel: "there'll be like one button here, Add New… it'll just
                    grow as you post more." Last, so it never sits between two
                    real categories. */}
                <option value={ADD_NEW_VALUE}>+ Add new…</option>
              </select>

              {adding ? (
                <div className={styles.addLabelRow} data-testid="add-label-row">
                  <input
                    className={styles.input}
                    type="text"
                    value={newLabel}
                    autoFocus
                    maxLength={MAX_LABEL_LENGTH}
                    data-testid="new-label-input"
                    aria-label="New title"
                    placeholder="Name your new title…"
                    onChange={(e) => setNewLabel(e.target.value)}
                    onKeyDown={(e) => {
                      // Enter submits. Without this the field sits inside the
                      // compose form and Enter would trigger the primary
                      // action, publishing a post the operator was still naming.
                      if (e.key === "Enter") {
                        e.preventDefault();
                        void submitNewLabel();
                      }
                      if (e.key === "Escape") {
                        setAdding(false);
                        setAddError(null);
                      }
                    }}
                  />
                  <button
                    type="button"
                    className="btn btn-primary"
                    disabled={addBusy}
                    data-testid="add-label-save"
                    onClick={() => void submitNewLabel()}
                  >
                    {addBusy ? "Adding…" : "Add"}
                  </button>
                  <button
                    type="button"
                    className="btn btn-light"
                    data-testid="add-label-cancel"
                    onClick={() => {
                      setAdding(false);
                      setAddError(null);
                    }}
                  >
                    Cancel
                  </button>
                </div>
              ) : null}
              {addError ? (
                <div className={styles.addLabelError} role="alert" data-testid="add-label-error">
                  {addError}
                </div>
              ) : null}
              {/* ENG-1268 — the per-row retire action. Builtins are filtered
                  out by `retirableLabels`, so they show no ×. */}
              <ManageList
                kind="title"
                rows={retirableLabels}
                open={manageLabels}
                onToggle={() => setManageLabels((v) => !v)}
                retiringId={retiringId}
                onRetire={(row) => void onRetire("label", row)}
              />
              {/* One error surface for both pickers — they share one handler
                  and only one retire can be in flight at a time. */}
              {retireError ? (
                <div className={styles.addLabelError} role="alert" data-testid="retire-error">
                  {retireError}
                </div>
              ) : null}

              {adding || addError ? <div style={{ marginBottom: 14 }} /> : null}
              <div style={{ marginBottom: 14 }} />

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
                  ? "Required — this body is the whole post. Write it so it sounds like the trainer would say it."
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
                    isEdit
                      ? busy || editPhotoEmpty || editPhotoUnsettled
                      : !canAct || busy || (mode === "schedule" && !canSchedule)
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
                  disabled={!canSchedule || busy || editPhotoEmpty || editPhotoUnsettled}
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

/**
 * ENG-1268 — the retire (×) affordance for the title and byline pickers.
 *
 * WHY IT IS A DISCLOSURE AND NOT A ROW OF ×s IN THE <select>: a native select
 * cannot host a per-option button, and both pickers are deliberately native
 * selects (ENG-979 chose one over a pill row at 14+ categories, and this
 * ticket's instruction is to reuse that control, not replace it). So the
 * action lives in a list under the field — one row per retirable name, each
 * with its own ×, which is the per-row action the ticket asks for.
 *
 * BUILTIN LABELS ARE SIMPLY ABSENT from `rows` (the caller filters them), so
 * "builtin labels show no ×" holds by construction rather than by a disabled
 * button the operator would try. A byline has no builtin concept at all.
 *
 * ONE component for both pickers: two copies of a destructive confirm is how
 * one of them ends up missing the "posts already using it keep it" sentence.
 */
function ManageList({
  kind,
  rows,
  open,
  onToggle,
  retiringId,
  onRetire,
}: {
  kind: "title" | "byline";
  rows: { id: string; name: string }[];
  open: boolean;
  onToggle: () => void;
  retiringId: string | null;
  onRetire: (row: { id: string; name: string }) => void;
}) {
  const noun = kind === "title" ? "titles" : "bylines";
  return (
    <div data-testid={`manage-${kind}`}>
      <button
        type="button"
        className={styles.manageToggle}
        data-testid={`manage-${kind}-toggle`}
        aria-expanded={open}
        onClick={onToggle}
      >
        {open ? `Done managing ${noun}` : `Manage ${noun}`}
      </button>
      {open ? (
        <ul className={styles.manageList} data-testid={`manage-${kind}-list`}>
          {rows.length === 0 ? (
            <li className={styles.manageEmpty}>
              {kind === "title"
                ? "Only built-in titles here — those are permanent."
                : "No bylines to remove yet."}
            </li>
          ) : (
            rows.map((row) => (
              <li key={row.id} className={styles.manageRow}>
                <span className={styles.manageName}>{row.name}</span>
                <button
                  type="button"
                  className={styles.manageRemove}
                  data-testid={`manage-${kind}-remove-${row.id}`}
                  /* Names the ROW, not just the action: "×" alone tells a
                     screen-reader user nothing about what it removes. */
                  aria-label={`Remove ${row.name}`}
                  disabled={retiringId === row.id}
                  onClick={() => onRetire(row)}
                >
                  ×
                </button>
              </li>
            ))
          )}
        </ul>
      ) : null}
    </div>
  );
}
