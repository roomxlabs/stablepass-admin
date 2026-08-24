// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import ComposeScreen from "./ComposeScreen";
import type { EditInitial, HorseOption, TrainerOption } from "./types";
import { POST_LABEL_PRESETS } from "@/lib/posts/labels";

// Mock the whole network layer so the component test never touches fetch /
// Supabase / Mux. Each fn is a spy we assert against.
const api = vi.hoisted(() => ({
  createDraft: vi.fn(),
  patchPost: vi.fn(),
  publishPost: vi.fn(),
  schedulePost: vi.fn(),
  discardDraft: vi.fn(),
  uploadVideoToMux: vi.fn(),
  uploadPhotoToStorage: vi.fn(),
}));
vi.mock("./api", () => api);

// next/link → plain anchor for the test renderer.
vi.mock("next/link", () => ({
  default: ({ children, href }: { children: React.ReactNode; href: string }) => (
    <a href={href}>{children}</a>
  ),
}));

// next/navigation → stub router so useRouter() works in the test renderer.
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));

const TRAINERS: TrainerOption[] = [
  { id: "t1", name: "Chris Waller" },
  { id: "t2", name: "Peter Moody" },
];

const HORSES: HorseOption[] = [
  {
    id: "h1",
    name: "Mahogany",
    photoUrl: null,
    stableName: "Randwick",
    trainerId: "t1",
    trainerName: "Chris Waller",
    racesToday: true,
  },
  {
    id: "h2",
    name: "Black Caviar",
    photoUrl: null,
    stableName: "Caulfield",
    trainerId: "t2",
    trainerName: "Peter Moody",
    racesToday: false,
  },
];

function renderScreen() {
  return render(<ComposeScreen horses={HORSES} trainers={TRAINERS} />);
}

function pickHorse(testId: string) {
  fireEvent.change(screen.getByTestId("horse-search"), { target: { value: "Mah" } });
  fireEvent.click(screen.getByTestId(testId));
}

// ENG-611: the post type is CHOSEN (step 2), never sniffed from the picked
// file — so any test that picks a non-video file must select the matching
// type first, or it hits the MIME-mismatch guard.
function selectType(type: string) {
  fireEvent.click(within(screen.getByTestId(`type-option-${type}`)).getByRole("radio"));
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("ComposeScreen", () => {
  it("renders the compose flow", () => {
    renderScreen();
    expect(screen.getByRole("heading", { name: "Compose post" })).toBeTruthy();
    expect(screen.getByText("Which horse is this for?")).toBeTruthy();
    expect(screen.getByText("Add the content.")).toBeTruthy();
    expect(screen.getByText("Write the caption.")).toBeTruthy();
  });

  it("edit mode: hydrates the post and saves changes via patchPost", async () => {
    api.patchPost.mockResolvedValue(undefined);
    const initial: EditInitial = {
      id: "post-9",
      status: "published",
      mediaType: "photo",
      mediaUrl: "https://signed.example/photo.jpg",
      title: "Old title",
      caption: "Old caption",
      bylineId: "t1",
      label: null,
      scheduledFor: null,
      horse: HORSES[0],
    };
    render(<ComposeScreen horses={HORSES} trainers={TRAINERS} initial={initial} />);

    // Title switches to edit; fields hydrate from the post.
    expect(screen.getByRole("heading", { name: "Edit post" })).toBeTruthy();
    expect((screen.getByTestId("title") as HTMLInputElement).value).toBe("Old title");
    expect((screen.getByTestId("caption") as HTMLTextAreaElement).value).toBe("Old caption");
    expect((screen.getByTestId("byline-select") as HTMLSelectElement).value).toBe("t1");
    // Media shown read-only; no horse search / create controls in edit mode.
    expect(screen.getByTestId("media-existing")).toBeTruthy();
    expect(screen.queryByTestId("horse-search")).toBeNull();

    // Edit title + caption + byline, then save → PATCH the existing post.
    fireEvent.change(screen.getByTestId("title"), { target: { value: "New title" } });
    fireEvent.change(screen.getByTestId("caption"), { target: { value: "New caption" } });
    fireEvent.change(screen.getByTestId("byline-select"), { target: { value: "t2" } });
    fireEvent.click(screen.getByTestId("primary-action"));

    await waitFor(() =>
      expect(api.patchPost).toHaveBeenCalledWith("post-9", {
        title: "New title",
        body: "New caption",
        sourceTrainerId: "t2",
      }),
    );
    // Editing a published post never touches the create/publish endpoints —
    // and offers no Publish now (drafts only).
    expect(api.createDraft).not.toHaveBeenCalled();
    expect(api.publishPost).not.toHaveBeenCalled();
    expect(screen.queryByTestId("publish-draft")).toBeNull();
  });

  it("edit mode on a DRAFT: Publish now saves the edits then publishes", async () => {
    api.patchPost.mockResolvedValue(undefined);
    api.publishPost.mockResolvedValue(undefined);
    const initial: EditInitial = {
      id: "post-7",
      status: "draft",
      mediaType: "photo",
      mediaUrl: "https://signed.example/photo.jpg",
      title: "",
      caption: "Almost ready",
      bylineId: "t1",
      label: null,
      scheduledFor: null,
      horse: HORSES[0],
    };
    render(<ComposeScreen horses={HORSES} trainers={TRAINERS} initial={initial} />);

    // A draft in edit mode keeps BOTH affordances (Publish now + Schedule).
    expect(screen.getByTestId("publish-draft")).toBeTruthy();
    expect(screen.getByTestId("edit-schedule")).toBeTruthy();

    fireEvent.click(screen.getByTestId("publish-draft"));

    // Fields persisted first, then the existing publish endpoint flips it live.
    await waitFor(() => expect(api.publishPost).toHaveBeenCalledWith("post-7"));
    expect(api.patchPost).toHaveBeenCalledWith("post-7", {
      title: null,
      body: "Almost ready",
      sourceTrainerId: "t1",
    });
    expect(api.createDraft).not.toHaveBeenCalled();
  });

  it("defaults the byline to the picked horse's trainer, and stays editable", () => {
    renderScreen();
    pickHorse("horse-opt-h1");

    const byline = screen.getByTestId("byline-select") as HTMLSelectElement;
    expect(byline.value).toBe("t1"); // Mahogany → Chris Waller

    // Editable: operator can override the byline.
    fireEvent.change(byline, { target: { value: "t2" } });
    expect(byline.value).toBe("t2");
  });

  it("uploads a photo then publishes via the endpoint", async () => {
    api.createDraft.mockResolvedValue({
      id: "p1",
      status: "draft",
      type: "photo",
      watermarked: false,
      uploadUrl: "https://storage.example/signed",
      path: "p1/original",
      token: "tok",
      bucket: "post-media",
    });
    api.uploadPhotoToStorage.mockResolvedValue(undefined);
    api.patchPost.mockResolvedValue(undefined);
    api.publishPost.mockResolvedValue(undefined);

    renderScreen();
    pickHorse("horse-opt-h1");
    selectType("photo");

    const file = new File([new Uint8Array([1, 2, 3])], "gallop.jpg", { type: "image/jpeg" });
    fireEvent.change(screen.getByTestId("media-input"), { target: { files: [file] } });

    // Draft created for the photo, uploaded straight to Storage (not via us).
    await waitFor(() => expect(api.createDraft).toHaveBeenCalledTimes(1));
    expect(api.createDraft).toHaveBeenCalledWith({
      horseId: "h1",
      type: "photo",
      sourceTrainerId: "t1",
    });
    await waitFor(() => expect(api.uploadPhotoToStorage).toHaveBeenCalledTimes(1));
    await screen.findByTestId("upload-done");

    fireEvent.change(screen.getByTestId("caption"), {
      target: { value: "Spot-on before Saturday." },
    });

    fireEvent.click(screen.getByTestId("primary-action"));

    // Title (empty → null) + caption + byline persisted, then the publish
    // endpoint called with the draft id.
    await waitFor(() => expect(api.publishPost).toHaveBeenCalledWith("p1"));
    expect(api.patchPost).toHaveBeenCalledWith("p1", {
      title: null,
      body: "Spot-on before Saturday.",
      sourceTrainerId: "t1",
      // ENG-748 — a single-photo post now also persists its post_media row 0.
      // This is the ticket's "mirror only; one post_media row", and ENG-740's
      // "row 0 is created lazily by the first admin edit": the mirror still
      // points at <postId>/original and nothing an existing client reads
      // changed, but the ordered table now knows about this photo too, so the
      // post can gain a second one later without a backfill.
      media: ["p1/original"],
    });
  });

  it("creates a video draft and PUTs the file straight to Mux", async () => {
    api.createDraft.mockResolvedValue({
      id: "v1",
      status: "draft",
      type: "video",
      watermarked: false,
      uploadUrl: "https://storage.mux.com/one-time-upload",
      muxUploadId: "mux-123",
    });
    api.uploadVideoToMux.mockResolvedValue(undefined);

    renderScreen();
    pickHorse("horse-opt-h1");

    const file = new File([new Uint8Array([9, 9, 9])], "gallop.mov", { type: "video/quicktime" });
    fireEvent.change(screen.getByTestId("media-input"), { target: { files: [file] } });

    // Video → draft created with type "video", bytes PUT to the Mux upload URL (not via us).
    await waitFor(() =>
      expect(api.createDraft).toHaveBeenCalledWith({
        horseId: "h1",
        type: "video",
        sourceTrainerId: "t1",
      }),
    );
    await waitFor(() =>
      expect(api.uploadVideoToMux).toHaveBeenCalledWith(
        "https://storage.mux.com/one-time-upload",
        file,
        expect.any(Function),
      ),
    );
    expect(api.uploadPhotoToStorage).not.toHaveBeenCalled();
  });

  // --- ENG-611: the post-type picker (video/photo/voice/text) ----------------

  it("post type picker: renders all 4 options, video selected by default", () => {
    renderScreen();
    const picker = screen.getByTestId("type-picker");
    expect(picker.getAttribute("role")).toBe("radiogroup");
    expect(picker.getAttribute("aria-label")).toBe("Post type");
    for (const type of ["video", "photo", "voice", "text"]) {
      expect(screen.getByTestId(`type-option-${type}`)).toBeTruthy();
    }
    expect(screen.getByTestId("type-option-video").getAttribute("data-selected")).toBe("true");
    expect(screen.getByTestId("type-option-photo").getAttribute("data-selected")).toBeNull();
    expect(screen.getByTestId("type-option-voice").getAttribute("data-selected")).toBeNull();
    expect(screen.getByTestId("type-option-text").getAttribute("data-selected")).toBeNull();
  });

  it("choosing Text removes the media step entirely", () => {
    renderScreen();
    expect(screen.getByTestId("media-input")).toBeTruthy();
    selectType("text");
    expect(screen.queryByTestId("media-input")).toBeNull();
  });

  it("the file input's accept attribute tracks the chosen type", () => {
    renderScreen();
    expect(screen.getByTestId("media-input").getAttribute("accept")).toBe("video/*");
    selectType("photo");
    expect(screen.getByTestId("media-input").getAttribute("accept")).toBe("image/*");
    selectType("voice");
    expect(screen.getByTestId("media-input").getAttribute("accept")).toBe("audio/*");
  });

  it("MIME mismatch: a file that doesn't match the chosen type errors and leaves the type unchanged", async () => {
    renderScreen();
    pickHorse("horse-opt-h1");
    // Default type is Video; pick an image file.
    const file = new File([new Uint8Array([1, 2, 3])], "gallop.jpg", { type: "image/jpeg" });
    fireEvent.change(screen.getByTestId("media-input"), { target: { files: [file] } });

    expect(await screen.findByTestId("type-mismatch")).toBeTruthy();
    expect(screen.getByTestId("type-option-video").getAttribute("data-selected")).toBe("true");
    expect(api.createDraft).not.toHaveBeenCalled();
  });

  it("switching type after a file is picked clears the file, discards the draft, and revokes the object URL", async () => {
    const createObjectURL = vi.fn(() => "blob:test-1");
    const revokeObjectURL = vi.fn();
    Object.defineProperty(URL, "createObjectURL", {
      value: createObjectURL,
      configurable: true,
      writable: true,
    });
    Object.defineProperty(URL, "revokeObjectURL", {
      value: revokeObjectURL,
      configurable: true,
      writable: true,
    });

    api.createDraft.mockResolvedValue({
      id: "v1",
      status: "draft",
      type: "video",
      watermarked: false,
      uploadUrl: "https://storage.mux.com/one-time-upload",
      muxUploadId: "mux-123",
    });
    api.uploadVideoToMux.mockResolvedValue(undefined);
    api.discardDraft.mockResolvedValue(undefined);

    renderScreen();
    pickHorse("horse-opt-h1");

    const file = new File([new Uint8Array([9, 9, 9])], "gallop.mov", { type: "video/quicktime" });
    fireEvent.change(screen.getByTestId("media-input"), { target: { files: [file] } });
    await waitFor(() => expect(api.createDraft).toHaveBeenCalledTimes(1));
    await screen.findByTestId("media-filled");

    selectType("photo");

    await waitFor(() => expect(api.discardDraft).toHaveBeenCalledWith("v1"));
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:test-1");
    expect((screen.getByTestId("media-input") as HTMLInputElement).value).toBe("");
    expect(screen.queryByTestId("media-filled")).toBeNull();
  });

  it("a text post: createDraft carries type 'text' + the body, and never touches an upload endpoint", async () => {
    api.createDraft.mockResolvedValue({ id: "tx1", status: "draft", type: "text", watermarked: false });
    api.patchPost.mockResolvedValue(undefined);
    api.publishPost.mockResolvedValue(undefined);

    renderScreen();
    pickHorse("horse-opt-h1");
    selectType("text");

    fireEvent.change(screen.getByTestId("caption"), { target: { value: "Stable update text" } });
    fireEvent.click(screen.getByTestId("primary-action"));

    await waitFor(() =>
      expect(api.createDraft).toHaveBeenCalledWith(
        expect.objectContaining({ type: "text", body: "Stable update text" }),
      ),
    );
    expect(api.uploadVideoToMux).not.toHaveBeenCalled();
    expect(api.uploadPhotoToStorage).not.toHaveBeenCalled();
  });

  it("a text post with an empty body: primary-action is disabled and createDraft is never called", () => {
    renderScreen();
    pickHorse("horse-opt-h1");
    selectType("text");

    const btn = screen.getByTestId("primary-action") as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    fireEvent.click(btn);
    expect(api.createDraft).not.toHaveBeenCalled();
  });

  // Regression: the readiness predicate desynced. `canAct` was applied to the
  // sidebar button and the status pill but NOT to the three topbar buttons,
  // which stayed on `draftReady` — structurally unreachable for a text post.
  // The screen said "Ready" with three permanently-dead controls next to it.
  it("a ready text post enables the TOPBAR actions too, not just the sidebar one", () => {
    renderScreen();
    pickHorse("horse-opt-h1");
    selectType("text");
    fireEvent.change(screen.getByTestId("caption"), { target: { value: "Stable update text" } });

    expect((screen.getByTestId("primary-action") as HTMLButtonElement).disabled).toBe(false);
    for (const name of ["Save draft", "Schedule", "Publish"]) {
      const btn = screen.getByRole("button", { name }) as HTMLButtonElement;
      expect(btn.disabled, `topbar "${name}" should be enabled for a ready text post`).toBe(false);
    }
  });

  // Regression: switching type while createDraft was in flight resurrected the
  // OLD draft via the late setDraft, and runAction then published that instead
  // of creating the text post — a type=video row going live with the text body.
  it("a type switch during an in-flight createDraft never publishes the abandoned draft", async () => {
    let releaseCreate: (v: unknown) => void = () => {};
    const pending = new Promise((resolve) => {
      releaseCreate = resolve;
    });
    api.createDraft.mockReturnValueOnce(pending);
    api.discardDraft.mockResolvedValue(undefined);
    api.patchPost.mockResolvedValue(undefined);
    api.publishPost.mockResolvedValue(undefined);

    renderScreen();
    pickHorse("horse-opt-h1");
    selectType("video");

    // Pick a video; createDraft hangs.
    const vid = new File([new Uint8Array([1, 2, 3])], "gallop.mp4", { type: "video/mp4" });
    fireEvent.change(screen.getByTestId("media-input"), { target: { files: [vid] } });
    await waitFor(() => expect(api.createDraft).toHaveBeenCalledTimes(1));

    // The operator gives up on the video and switches to Text mid-flight.
    selectType("text");

    // Only now does the video draft land.
    releaseCreate({
      id: "VIDEO-DRAFT",
      status: "draft",
      type: "video",
      watermarked: false,
      uploadUrl: "https://mux.example/upload",
      muxUploadId: "up1",
    });
    await waitFor(() => expect(api.discardDraft).toHaveBeenCalledWith("VIDEO-DRAFT"));

    // Publish the text post.
    api.createDraft.mockResolvedValue({
      id: "TEXT-DRAFT",
      status: "draft",
      type: "text",
      watermarked: false,
    });
    fireEvent.change(screen.getByTestId("caption"), { target: { value: "Stable update text" } });
    fireEvent.click(screen.getByTestId("primary-action"));

    await waitFor(() => expect(api.publishPost).toHaveBeenCalled());
    // The abandoned video draft must never be the thing that goes live.
    expect(api.publishPost).toHaveBeenCalledWith("TEXT-DRAFT");
    expect(api.publishPost).not.toHaveBeenCalledWith("VIDEO-DRAFT");
    expect(api.patchPost).not.toHaveBeenCalledWith("VIDEO-DRAFT", expect.anything());
  });

  // --- Scheduling: explicit Date + Time picker (create + edit) ----------------

  async function uploadPhoto() {
    api.createDraft.mockResolvedValue({
      id: "p1",
      status: "draft",
      type: "photo",
      watermarked: false,
      uploadUrl: "https://storage.example/signed",
      path: "p1/original",
      token: "tok",
      bucket: "post-media",
    });
    api.uploadPhotoToStorage.mockResolvedValue(undefined);
    selectType("photo");
    const file = new File([new Uint8Array([1, 2, 3])], "gallop.jpg", { type: "image/jpeg" });
    fireEvent.change(screen.getByTestId("media-input"), { target: { files: [file] } });
    await screen.findByTestId("upload-done");
  }

  it("create flow: Schedule combines Date + Time into the UTC ISO of the local pick", async () => {
    api.patchPost.mockResolvedValue(undefined);
    api.schedulePost.mockResolvedValue(undefined);

    renderScreen();
    pickHorse("horse-opt-h1");
    await uploadPhoto();

    // "Schedule for later" is the 2nd of the three When-to-publish radios; picking
    // it reveals the Date + Time pair — two separately labelled native controls.
    // Scoped to name="schedule" (ENG-611 added 4 more radios ahead of these, in
    // the post-type picker, so an unscoped index would now hit the wrong group).
    const scheduleRadios = screen
      .getAllByRole("radio")
      .filter((el) => (el as HTMLInputElement).name === "schedule");
    fireEvent.click(scheduleRadios[1]);
    expect(screen.getByText("Date")).toBeTruthy();
    expect(screen.getByText("Time")).toBeTruthy();

    fireEvent.change(screen.getByTestId("schedule-date"), { target: { value: "2099-06-21" } });
    fireEvent.change(screen.getByTestId("schedule-time"), { target: { value: "16:30" } });
    fireEvent.click(screen.getByTestId("primary-action"));

    // The local pick is converted to the correct UTC instant, exactly as the old
    // single datetime-local did (new Date(local).toISOString()).
    const expectedIso = new Date("2099-06-21T16:30").toISOString();
    await waitFor(() => expect(api.schedulePost).toHaveBeenCalledWith("p1", expectedIso));
    // Fields PATCHed before the schedule action, same as the publish path.
    expect(api.patchPost).toHaveBeenCalledWith("p1", {
      title: null,
      body: "",
      sourceTrainerId: "t1",
      // ENG-748 — the scheduled path persists the photo set too, for the same
      // reason the publish path does (post_media row 0 is created lazily on the
      // first admin write). Same single photo, same mirror.
      media: ["p1/original"],
    });
    expect(api.patchPost.mock.invocationCallOrder[0]).toBeLessThan(
      api.schedulePost.mock.invocationCallOrder[0],
    );
    expect(api.publishPost).not.toHaveBeenCalled();
  });

  it("edit mode: draft shows the Schedule section (Schedule); published shows none", () => {
    const base = {
      mediaType: "photo" as const,
      mediaUrl: "https://signed.example/photo.jpg",
      title: "T",
      caption: "C",
      bylineId: "t1",
      label: null,
      horse: HORSES[0],
    };

    const draft = render(
      <ComposeScreen
        horses={HORSES}
        trainers={TRAINERS}
        initial={{ ...base, id: "d1", status: "draft", scheduledFor: null }}
      />,
    );
    expect(screen.getByTestId("edit-schedule")).toBeTruthy();
    const label = screen.getByTestId("schedule-action").textContent ?? "";
    expect(label).toContain("Schedule");
    expect(label).not.toContain("Update");
    draft.unmount();

    render(
      <ComposeScreen
        horses={HORSES}
        trainers={TRAINERS}
        initial={{ ...base, id: "u1", status: "published", scheduledFor: null }}
      />,
    );
    expect(screen.queryByTestId("edit-schedule")).toBeNull();
  });

  it("edit mode on a SCHEDULED post: current schedule + Update schedule; PATCH then re-schedule", async () => {
    api.patchPost.mockResolvedValue(undefined);
    api.schedulePost.mockResolvedValue(undefined);
    const initial: EditInitial = {
      id: "post-5",
      status: "scheduled",
      mediaType: "photo",
      mediaUrl: "https://signed.example/photo.jpg",
      title: "Race day",
      caption: "Big race Saturday",
      bylineId: "t1",
      label: null,
      scheduledFor: "2099-06-20T09:30:00.000Z",
      horse: HORSES[0],
    };
    render(<ComposeScreen horses={HORSES} trainers={TRAINERS} initial={initial} />);

    expect(screen.getByTestId("edit-schedule")).toBeTruthy();
    expect(screen.getByTestId("current-schedule")).toBeTruthy();
    expect(screen.getByTestId("schedule-action").textContent).toContain("Update schedule");

    fireEvent.change(screen.getByTestId("schedule-date"), { target: { value: "2099-07-01" } });
    fireEvent.change(screen.getByTestId("schedule-time"), { target: { value: "18:45" } });
    fireEvent.click(screen.getByTestId("schedule-action"));

    const expectedIso = new Date("2099-07-01T18:45").toISOString();
    await waitFor(() => expect(api.schedulePost).toHaveBeenCalledWith("post-5", expectedIso));
    expect(api.patchPost).toHaveBeenCalledWith("post-5", {
      title: "Race day",
      body: "Big race Saturday",
      sourceTrainerId: "t1",
    });
    expect(api.patchPost.mock.invocationCallOrder[0]).toBeLessThan(
      api.schedulePost.mock.invocationCallOrder[0],
    );
  });

  it("schedule: a past Date + Time renders an inline error and never calls the endpoint", () => {
    const initial: EditInitial = {
      id: "post-3",
      status: "draft",
      mediaType: "photo",
      mediaUrl: "https://signed.example/photo.jpg",
      title: "T",
      caption: "C",
      bylineId: "t1",
      label: null,
      scheduledFor: null,
      horse: HORSES[0],
    };
    render(<ComposeScreen horses={HORSES} trainers={TRAINERS} initial={initial} />);

    fireEvent.change(screen.getByTestId("schedule-date"), { target: { value: "2000-01-01" } });
    fireEvent.change(screen.getByTestId("schedule-time"), { target: { value: "10:00" } });
    fireEvent.click(screen.getByTestId("schedule-action"));

    expect(screen.getByTestId("action-note").textContent).toMatch(/past/i);
    expect(api.schedulePost).not.toHaveBeenCalled();
    expect(api.patchPost).not.toHaveBeenCalled();
  });

  it("schedule: a 409 invalid_status endpoint error renders inline with a refresh hint", async () => {
    api.patchPost.mockResolvedValue(undefined);
    // Simulate the cron publishing the post between load and confirm → 409.
    api.schedulePost.mockRejectedValue(
      Object.assign(new Error("A published post cannot be scheduled."), {
        code: "invalid_status",
        status: 409,
      }),
    );
    const initial: EditInitial = {
      id: "post-8",
      status: "scheduled",
      mediaType: "photo",
      mediaUrl: "https://signed.example/photo.jpg",
      title: "T",
      caption: "C",
      bylineId: "t1",
      label: null,
      scheduledFor: "2099-06-20T09:30:00.000Z",
      horse: HORSES[0],
    };
    render(<ComposeScreen horses={HORSES} trainers={TRAINERS} initial={initial} />);

    fireEvent.change(screen.getByTestId("schedule-date"), { target: { value: "2099-07-01" } });
    fireEvent.change(screen.getByTestId("schedule-time"), { target: { value: "18:45" } });
    fireEvent.click(screen.getByTestId("schedule-action"));

    await waitFor(() =>
      expect(screen.getByTestId("action-note").textContent).toMatch(/refresh/i),
    );
  });

  it("schedule: a server-returned scheduled_for_in_past (clock skew) maps to the friendly inline line", async () => {
    api.patchPost.mockResolvedValue(undefined);
    // A future pick clears the client guard, but the endpoint rejects it as past
    // (clock skew between the browser and the server).
    api.schedulePost.mockRejectedValue(
      Object.assign(new Error("scheduledFor must be in the future."), {
        code: "scheduled_for_in_past",
        status: 400,
      }),
    );
    const initial: EditInitial = {
      id: "post-6",
      status: "draft",
      mediaType: "photo",
      mediaUrl: "https://signed.example/photo.jpg",
      title: "T",
      caption: "C",
      bylineId: "t1",
      label: null,
      scheduledFor: null,
      horse: HORSES[0],
    };
    render(<ComposeScreen horses={HORSES} trainers={TRAINERS} initial={initial} />);

    fireEvent.change(screen.getByTestId("schedule-date"), { target: { value: "2099-07-01" } });
    fireEvent.change(screen.getByTestId("schedule-time"), { target: { value: "18:45" } });
    fireEvent.click(screen.getByTestId("schedule-action"));

    // Endpoint reached (guard passed), then the code maps to the friendly line.
    await waitFor(() => expect(api.schedulePost).toHaveBeenCalledTimes(1));
    expect(screen.getByTestId("action-note").textContent).toMatch(/past/i);
  });
});

// ---------------------------------------------------------------------------
// ENG-558 — the measurement state machine, tested where it is OWNED.
//
// PostPreview.test.tsx drives a harness that re-implements this ownership, so
// it proves the preview renders correctly GIVEN correct state — never that
// ComposeScreen produces it. Without the tests below, deleting the reset in
// onPickFile (stale readout) or handing onMeasure to the edit-mode preview
// (the HLS-rendition lie) both leave the whole suite green.
// ---------------------------------------------------------------------------
describe("ComposeScreen — preview measurement", () => {
  const VIDEO = new File([new Uint8Array([1, 2, 3])], "reel.mp4", { type: "video/mp4" });
  const VIDEO_2 = new File([new Uint8Array([4, 5, 6])], "swap.mp4", { type: "video/mp4" });

  // jsdom implements neither, so without these `objectUrl()` returns null and
  // the preview never renders a media element to measure.
  beforeEach(() => {
    let n = 0;
    Object.defineProperty(URL, "createObjectURL", {
      value: vi.fn(() => `blob:test-${++n}`),
      configurable: true,
      writable: true,
    });
    Object.defineProperty(URL, "revokeObjectURL", {
      value: vi.fn(),
      configurable: true,
      writable: true,
    });
  });

  function pickFile(file: File) {
    fireEvent.change(screen.getByTestId("media-input"), { target: { files: [file] } });
  }

  it("shows no readout until a file is picked", () => {
    renderScreen();
    pickHorse("horse-opt-h1");
    expect(screen.queryByTestId("preview-readout")).toBeNull();
  });

  it("enters 'Measuring…' on pick, and asserts no orientation yet", async () => {
    api.createDraft.mockResolvedValue({
      id: "d1",
      status: "draft",
      type: "video",
      watermarked: false,
      uploadUrl: "http://up.test/1",
      muxUploadId: "u1",
    });
    api.uploadVideoToMux.mockResolvedValue(undefined);

    renderScreen();
    pickHorse("horse-opt-h1");
    pickFile(VIDEO);

    const readout = await screen.findByTestId("preview-readout");
    expect(readout.textContent).toBe("Measuring…");
    expect(readout.textContent).not.toMatch(/Landscape|Portrait|Square/);
    // ...and the box is at the 16:10 fallback, never a guessed orientation.
    expect(screen.getByTestId("preview-media").style.aspectRatio).toBe("1.6");
  });

  it("prints the measured orientation once the media reports its size", async () => {
    api.createDraft.mockResolvedValue({
      id: "d1",
      status: "draft",
      type: "video",
      watermarked: false,
      uploadUrl: "http://up.test/1",
      muxUploadId: "u1",
    });
    api.uploadVideoToMux.mockResolvedValue(undefined);

    renderScreen();
    pickHorse("horse-opt-h1");
    pickFile(VIDEO);
    await screen.findByTestId("preview-readout");

    const video = screen.getByTestId("preview-video") as HTMLVideoElement;
    Object.defineProperty(video, "videoWidth", { value: 1080, configurable: true });
    Object.defineProperty(video, "videoHeight", { value: 1920, configurable: true });
    fireEvent.loadedMetadata(video);

    // ENG-747: end to end through the real screen, a 9:16 file now previews as
    // a full reel. This is the assertion that proves the fix reaches the
    // operator, not just the pure helper.
    await waitFor(() =>
      expect(screen.getByTestId("preview-readout").textContent).toBe(
        "1080×1920 · Portrait 9:16 · Members see it as a reel at 9:16",
      ),
    );
    expect(screen.getByTestId("preview-media").style.aspectRatio).toBe("0.5625");
  });

  it("clears the previous measurement when the operator swaps the file", async () => {
    api.createDraft.mockResolvedValue({
      id: "d1",
      status: "draft",
      type: "video",
      watermarked: false,
      uploadUrl: "http://up.test/1",
      muxUploadId: "u1",
    });
    api.uploadVideoToMux.mockResolvedValue(undefined);
    // Replacing a file calls discardDraft(...).catch — a bare vi.fn() returns
    // undefined and throws synchronously before every setState below it.
    api.discardDraft.mockResolvedValue(undefined);

    renderScreen();
    pickHorse("horse-opt-h1");
    pickFile(VIDEO);
    await screen.findByTestId("preview-readout");

    const video = screen.getByTestId("preview-video") as HTMLVideoElement;
    Object.defineProperty(video, "videoWidth", { value: 1920, configurable: true });
    Object.defineProperty(video, "videoHeight", { value: 1080, configurable: true });
    fireEvent.loadedMetadata(video);
    await waitFor(() =>
      expect(screen.getByTestId("preview-readout").textContent).toContain("Landscape"),
    );

    // Swap: the readout must NOT keep describing the file that was replaced.
    pickFile(VIDEO_2);
    await waitFor(() => {
      const text = screen.getByTestId("preview-readout").textContent ?? "";
      expect(text).toBe("Measuring…");
      expect(text).not.toContain("1920×1080");
    });
  });

  it("edit mode measures NOTHING — the source is an HLS rendition", async () => {
    const initial: EditInitial = {
      id: "post-9",
      status: "draft",
      mediaType: "video",
      mediaUrl: "https://stream.example/asset.m3u8?token=t",
      title: "T",
      caption: "C",
      bylineId: "t1",
      label: null,
      scheduledFor: null,
      horse: HORSES[0],
    };
    render(<ComposeScreen horses={HORSES} trainers={TRAINERS} initial={initial} />);

    // No readout at all...
    expect(screen.queryByTestId("preview-readout")).toBeNull();

    // ...and even if the element reports a size, it must be ignored: hls.js
    // starts on a low-bitrate rendition, so 640x360 here is the RENDITION, not
    // the 1080p asset. Printing it would be worse than printing nothing.
    const video = screen.getByTestId("preview-video") as HTMLVideoElement;
    Object.defineProperty(video, "videoWidth", { value: 640, configurable: true });
    Object.defineProperty(video, "videoHeight", { value: 360, configurable: true });
    fireEvent.loadedMetadata(video);

    await waitFor(() => expect(screen.queryByTestId("preview-readout")).toBeNull());
  });

  it("shows the race badge only for a horse that races today", () => {
    renderScreen();
    pickHorse("horse-opt-h1"); // Mahogany — racesToday: true
    expect(screen.getByTestId("preview-race-badge")).toBeTruthy();

    cleanup();
    renderScreen();
    fireEvent.change(screen.getByTestId("horse-search"), { target: { value: "Black" } });
    fireEvent.click(screen.getByTestId("horse-opt-h2")); // Black Caviar — false
    expect(screen.queryByTestId("preview-race-badge")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// ENG-745 — label picker, the removed caption cap, and the full horse roster.
// ---------------------------------------------------------------------------

/** An edit-mode fixture; `label` is the field under test. */
function editInitial(label: string | null): EditInitial {
  return {
    id: "post-745",
    status: "published",
    mediaType: "photo",
    mediaUrl: "https://signed.example/photo.jpg",
    title: "Old title",
    caption: "Old caption",
    bylineId: "t1",
    label,
    scheduledFor: null,
    horse: HORSES[0],
  };
}

describe("ENG-745 · label picker", () => {
  it("offers No label plus all 13 presets, in the contract's order", () => {
    renderScreen();
    const select = screen.getByTestId("label-select") as HTMLSelectElement;
    const options = [...select.options].map((o) => o.value);

    // "" is the No label option; the rest must be the presets, in order and
    // complete. Comparing the whole array (not `toContain` per preset) is what
    // catches an accidental reorder or a dropped entry.
    expect(options).toEqual(["", ...POST_LABEL_PRESETS]);
    expect(select.options[0].textContent).toBe("No label");
    // Not a disabled placeholder — clearing a category must be selectable.
    expect(select.options[0].disabled).toBe(false);
  });

  it("renders the middle-dot preset with U+00B7, not a hyphen", () => {
    renderScreen();
    const select = screen.getByTestId("label-select") as HTMLSelectElement;
    const raceDay = [...select.options].find((o) => o.value.startsWith("Race Day"));
    expect(raceDay?.value).toBe("Race Day · Today");
    expect(raceDay?.value).not.toContain("-");
  });

  it("defaults to No label when composing a new post", () => {
    renderScreen();
    expect((screen.getByTestId("label-select") as HTMLSelectElement).value).toBe("");
  });

  it("seeds the picker from the post being edited", () => {
    render(<ComposeScreen horses={HORSES} trainers={TRAINERS} initial={editInitial("Trackwork")} />);
    expect((screen.getByTestId("label-select") as HTMLSelectElement).value).toBe("Trackwork");
  });

  it("opens an OLD unlabelled post on No label and does not write a label at all", async () => {
    api.patchPost.mockResolvedValue(undefined);
    render(<ComposeScreen horses={HORSES} trainers={TRAINERS} initial={editInitial(null)} />);
    expect((screen.getByTestId("label-select") as HTMLSelectElement).value).toBe("");

    // Save without touching the picker. The key must be ABSENT, not null:
    // absent tells the route to leave the column alone, which is the only
    // reading that cannot damage a value this build did not put there.
    fireEvent.click(screen.getByTestId("primary-action"));
    await waitFor(() => expect(api.patchPost).toHaveBeenCalled());
    expect(api.patchPost.mock.calls[0][1]).not.toHaveProperty("label");
  });

  it("sends the chosen preset on save", async () => {
    api.patchPost.mockResolvedValue(undefined);
    render(<ComposeScreen horses={HORSES} trainers={TRAINERS} initial={editInitial(null)} />);

    fireEvent.change(screen.getByTestId("label-select"), { target: { value: "Jockey Comments" } });
    fireEvent.click(screen.getByTestId("primary-action"));
    await waitFor(() =>
      expect(api.patchPost).toHaveBeenCalledWith(
        "post-745",
        expect.objectContaining({ label: "Jockey Comments" }),
      ),
    );
  });

  it("clears a label back to null when the operator picks No label", async () => {
    api.patchPost.mockResolvedValue(undefined);
    render(<ComposeScreen horses={HORSES} trainers={TRAINERS} initial={editInitial("Trackwork")} />);

    fireEvent.change(screen.getByTestId("label-select"), { target: { value: "" } });
    fireEvent.click(screen.getByTestId("primary-action"));
    // "" is the picker's No label; the wire value must be a real null, because
    // the route treats "" and null as a clear but absent as "leave alone".
    await waitFor(() =>
      expect(api.patchPost).toHaveBeenCalledWith("post-745", expect.objectContaining({ label: null })),
    );
  });
});

describe("ENG-745 · the caption cap is gone", () => {
  it("puts NO maxLength on the caption input", () => {
    renderScreen();
    const caption = screen.getByTestId("caption") as HTMLTextAreaElement;
    // THE regression assertion. `maxLength` is what silently truncated a pasted
    // trainer quote at 240 with no message, so assert its ABSENCE: jsdom
    // reports an unset maxLength as -1, and the attribute must not be there.
    expect(caption.hasAttribute("maxlength")).toBe(false);
    expect(caption.maxLength).toBe(-1);
  });

  it("accepts a 500-character caption in full and counts it passively", () => {
    renderScreen();
    const long = "x".repeat(500);
    const caption = screen.getByTestId("caption") as HTMLTextAreaElement;
    fireEvent.change(caption, { target: { value: long } });

    expect(caption.value).toHaveLength(500);
    expect(screen.getByTestId("caption-counter").textContent).toBe("500 characters");
  });

  it("shows a plain count with no limit and no over-limit state", () => {
    renderScreen();
    const counter = screen.getByTestId("caption-counter");
    // No "/240", and nothing telling the operator to keep it under a limit
    // that no longer exists anywhere in the stack.
    expect(counter.textContent).toBe("0 characters");
    expect(counter.textContent).not.toContain("/");
    expect(screen.queryByText(/keep it under/i)).toBeNull();
    expect(screen.queryByText(/240/)).toBeNull();
  });
});

describe("ENG-745 · the horse picker is not truncated at 8", () => {
  /** A roster bigger than the old slice, so the 9th onward is meaningful. */
  const MANY: HorseOption[] = Array.from({ length: 12 }, (_, i) => ({
    id: `hz${i + 1}`,
    name: `Horse ${String(i + 1).padStart(2, "0")}`,
    photoUrl: null,
    stableName: "Randwick",
    trainerId: "t1",
    trainerName: "Chris Waller",
    racesToday: false,
  }));

  function openPicker() {
    render(<ComposeScreen horses={MANY} trainers={TRAINERS} />);
    fireEvent.focus(screen.getByTestId("horse-search"));
  }

  it("lists every horse with an empty query, not just the first 8", () => {
    openPicker();
    const rows = within(screen.getByTestId("horse-results")).getAllByRole("button");
    expect(rows).toHaveLength(12);
    // The 9th and the last are the ones the old slice(0, 8) made unreachable —
    // and with the search box empty, which is how the picker opens.
    expect(screen.getByTestId("horse-opt-hz9")).toBeTruthy();
    expect(screen.getByTestId("horse-opt-hz12")).toBeTruthy();
  });

  it("still narrows on the text filter", () => {
    openPicker();
    fireEvent.change(screen.getByTestId("horse-search"), { target: { value: "Horse 1" } });
    // Substring match, so "Horse 1" narrows to Horse 10, 11 and 12 — NOT to
    // "Horse 01", which contains "Horse 0". Three rows, down from twelve.
    const rows = within(screen.getByTestId("horse-results")).getAllByRole("button");
    expect(rows).toHaveLength(3);
    expect(screen.getByTestId("horse-opt-hz12")).toBeTruthy();
    expect(screen.queryByTestId("horse-opt-hz9")).toBeNull();
    expect(screen.queryByTestId("horse-opt-hz1")).toBeNull();
  });

  it("keeps a filtered result set beyond 8 whole", () => {
    openPicker();
    fireEvent.change(screen.getByTestId("horse-search"), { target: { value: "Horse" } });
    // All 12 match; the old code sliced this to 8 too.
    expect(within(screen.getByTestId("horse-results")).getAllByRole("button")).toHaveLength(12);
  });

  it("selects a horse that used to be past the cut", () => {
    openPicker();
    fireEvent.click(screen.getByTestId("horse-opt-hz11"));
    expect(screen.getByTestId("horse-pick").textContent).toContain("Horse 11");
  });
});

// ---------------------------------------------------------------------------
// A stored label this build has no preset for. Reachable whenever stablepass-be
// adds or drops a preset and admin has not been redeployed — the same version
// skew the routes' 23514 backstop exists for. Found in review; before the fix
// the <select> fell back to "No label" while state held the real value, so
// editing only the caption either 400'd the entire save or silently relabelled
// the post, and the operator could not even correct it (re-picking the option
// already displayed fires no change event).
// ---------------------------------------------------------------------------
describe("ENG-745 · a label this build does not know", () => {
  const UNKNOWN = "Barrier Trial Report"; // plausible 14th preset, not in ours

  it("shows the stored value instead of pretending there is none", () => {
    render(<ComposeScreen horses={HORSES} trainers={TRAINERS} initial={editInitial(UNKNOWN)} />);
    const select = screen.getByTestId("label-select") as HTMLSelectElement;

    // The control must not lie about the post in front of you.
    expect(select.value).toBe(UNKNOWN);
    expect(select.selectedIndex).not.toBe(0);
    expect(select.options[select.selectedIndex].textContent).toContain(UNKNOWN);
  });

  it("leaves it untouched when the operator edits something else", async () => {
    api.patchPost.mockResolvedValue(undefined);
    render(<ComposeScreen horses={HORSES} trainers={TRAINERS} initial={editInitial(UNKNOWN)} />);

    fireEvent.change(screen.getByTestId("caption"), { target: { value: "Just a caption fix" } });
    fireEvent.click(screen.getByTestId("primary-action"));

    await waitFor(() => expect(api.patchPost).toHaveBeenCalled());
    const payload = api.patchPost.mock.calls[0][1];
    // Not sent at all — so the route cannot reject it, and the caption edit
    // lands instead of being lost to a 400 about a field nobody touched.
    expect(payload).not.toHaveProperty("label");
    expect(payload.body).toBe("Just a caption fix");
  });

  it("still lets the operator replace it with a real preset, or clear it", async () => {
    api.patchPost.mockResolvedValue(undefined);
    render(<ComposeScreen horses={HORSES} trainers={TRAINERS} initial={editInitial(UNKNOWN)} />);

    fireEvent.change(screen.getByTestId("label-select"), { target: { value: "Trackwork" } });
    fireEvent.click(screen.getByTestId("primary-action"));
    await waitFor(() =>
      expect(api.patchPost).toHaveBeenCalledWith(
        "post-745",
        expect.objectContaining({ label: "Trackwork" }),
      ),
    );

    cleanup();
    vi.clearAllMocks();
    api.patchPost.mockResolvedValue(undefined);
    render(<ComposeScreen horses={HORSES} trainers={TRAINERS} initial={editInitial(UNKNOWN)} />);
    fireEvent.change(screen.getByTestId("label-select"), { target: { value: "" } });
    fireEvent.click(screen.getByTestId("primary-action"));
    await waitFor(() =>
      expect(api.patchPost).toHaveBeenCalledWith(
        "post-745",
        expect.objectContaining({ label: null }),
      ),
    );
  });

  it("offers no pass-through option when the stored label IS a preset", () => {
    render(<ComposeScreen horses={HORSES} trainers={TRAINERS} initial={editInitial("Trial")} />);
    const select = screen.getByTestId("label-select") as HTMLSelectElement;
    // Exactly "No label" + the 13 presets; nothing extra bolted on.
    expect([...select.options].map((o) => o.value)).toEqual(["", ...POST_LABEL_PRESETS]);
    expect(select.value).toBe("Trial");
  });
});

// ---------------------------------------------------------------------------
// ENG-748 — multi-photo compose: the multiple input, the cap, the reorder strip
// and the media_url mirror that has to follow it.
// ---------------------------------------------------------------------------
describe("ENG-748 · multi-photo compose", () => {
  /** N photo Files, named so display order is legible in a failure message. */
  function photoFiles(n: number): File[] {
    return Array.from(
      { length: n },
      (_, i) => new File([new Uint8Array([i])], `p${i + 1}.jpg`, { type: "image/jpeg" }),
    );
  }

  /** The 202 a photo create returns, with one upload target per slot. */
  function draftWithSlots(n: number) {
    return {
      id: "p1",
      status: "draft",
      type: "photo",
      watermarked: false,
      uploadUrl: "https://storage.local/post-media/p1/original",
      path: "p1/original",
      token: "tok-0",
      bucket: "post-media",
      uploads: Array.from({ length: n }, (_, slot) => ({
        sortOrder: slot,
        path: slot === 0 ? "p1/original" : `p1/photo-${slot}`,
        token: `tok-${slot}`,
        uploadUrl: `https://storage.local/post-media/p1/${slot === 0 ? "original" : `photo-${slot}`}`,
        bucket: "post-media",
      })),
    };
  }

  /** Pick `n` photos and wait for every tile to settle. */
  async function pickPhotos(n: number) {
    api.createDraft.mockResolvedValue(draftWithSlots(n));
    api.uploadPhotoToStorage.mockResolvedValue(undefined);
    api.patchPost.mockResolvedValue(undefined);
    api.publishPost.mockResolvedValue(undefined);

    renderScreen();
    pickHorse("horse-opt-h1");
    selectType("photo");
    fireEvent.change(screen.getByTestId("media-input"), { target: { files: photoFiles(n) } });
    await waitFor(() => expect(api.uploadPhotoToStorage).toHaveBeenCalledTimes(n));
    await screen.findByTestId("upload-done");
  }

  /** The strip's display order, read off the tiles' thumbnails. */
  const stripOrder = () =>
    screen
      .getAllByTestId(/^photo-tile-\d+$/)
      .map((t) => t.querySelector("img")?.getAttribute("src") ?? "");

  describe("the multiple attribute is photo-only", () => {
    it("sets `multiple` once the operator chooses Photo", () => {
      renderScreen();
      selectType("photo");
      expect((screen.getByTestId("media-input") as HTMLInputElement).multiple).toBe(true);
    });

    it("does NOT set it for video — a single Mux asset", () => {
      renderScreen();
      selectType("video");
      expect((screen.getByTestId("media-input") as HTMLInputElement).multiple).toBe(false);
    });

    it("does NOT set it for voice — a single Storage object", () => {
      renderScreen();
      selectType("voice");
      expect((screen.getByTestId("media-input") as HTMLInputElement).multiple).toBe(false);
    });

    it("does NOT set it in edit mode, where media is read-only", () => {
      const initial: EditInitial = {
        id: "post-9",
        status: "published",
        mediaType: "photo",
        mediaUrl: "https://signed.example/photo.jpg",
        title: "T",
        caption: "C",
        bylineId: "t1",
        label: null,
        scheduledFor: null,
        horse: HORSES[0],
      };
      render(<ComposeScreen horses={HORSES} trainers={TRAINERS} initial={initial} />);
      expect((screen.getByTestId("media-input") as HTMLInputElement).multiple).toBe(false);
    });
  });

  describe("the cap", () => {
    it("blocks 11 files with a message and uploads NOTHING", async () => {
      api.createDraft.mockResolvedValue(draftWithSlots(11));
      renderScreen();
      pickHorse("horse-opt-h1");
      selectType("photo");
      fireEvent.change(screen.getByTestId("media-input"), { target: { files: photoFiles(11) } });

      const err = await screen.findByTestId("photo-error");
      expect(err.textContent).toContain("up to 10 photos");
      expect(err.textContent).toContain("you picked 11");
      // The whole point: nothing was created and nothing was uploaded.
      expect(api.createDraft).not.toHaveBeenCalled();
      expect(api.uploadPhotoToStorage).not.toHaveBeenCalled();
      expect(screen.queryByTestId("photo-strip")).toBeNull();
    });

    it("accepts exactly 10", async () => {
      await pickPhotos(10);
      expect(screen.getAllByTestId(/^photo-tile-\d+$/)).toHaveLength(10);
      expect(api.uploadPhotoToStorage).toHaveBeenCalledTimes(10);
    });
  });

  describe("the upload set", () => {
    it("asks for one target per file and uploads each to its own slot path", async () => {
      await pickPhotos(3);
      expect(api.createDraft).toHaveBeenCalledWith({
        horseId: "h1",
        type: "photo",
        sourceTrainerId: "t1",
        photoCount: 3,
      });
      // Slot 0 keeps <postId>/original; extras take <postId>/photo-<n>.
      expect(api.uploadPhotoToStorage.mock.calls.map((c) => c[0].path)).toEqual([
        "p1/original",
        "p1/photo-1",
        "p1/photo-2",
      ]);
    });

    it("omits photoCount entirely for a single photo (byte-identical request)", async () => {
      await pickPhotos(1);
      expect(api.createDraft).toHaveBeenCalledWith({
        horseId: "h1",
        type: "photo",
        sourceTrainerId: "t1",
      });
    });

    it("renders a strip tile per photo, numbered from 1", async () => {
      await pickPhotos(3);
      expect(screen.getByTestId("photo-pos-0").textContent).toBe("1");
      expect(screen.getByTestId("photo-pos-2").textContent).toBe("3");
      expect(screen.getByTestId("photo-strip-help").textContent).toContain("3 of 10 photos");
    });

    it("badges only position 0 as the cover", async () => {
      await pickPhotos(3);
      expect(screen.getAllByTestId("photo-cover")).toHaveLength(1);
      const tile0 = screen.getByTestId("photo-tile-0");
      expect(within(tile0).getByTestId("photo-cover")).toBeTruthy();
    });
  });

  describe("reorder", () => {
    it("moves a photo up, and the strip order follows", async () => {
      await pickPhotos(3);
      const before = stripOrder();
      fireEvent.click(screen.getByTestId("photo-up-2"));
      const after = stripOrder();
      expect(after).toEqual([before[0], before[2], before[1]]);
    });

    it("moves a photo down by exactly one place", async () => {
      await pickPhotos(3);
      const before = stripOrder();
      fireEvent.click(screen.getByTestId("photo-down-0"));
      expect(stripOrder()).toEqual([before[1], before[0], before[2]]);
    });

    it("disables up on the first tile and down on the last", async () => {
      await pickPhotos(3);
      expect((screen.getByTestId("photo-up-0") as HTMLButtonElement).disabled).toBe(true);
      expect((screen.getByTestId("photo-down-2") as HTMLButtonElement).disabled).toBe(true);
      expect((screen.getByTestId("photo-up-2") as HTMLButtonElement).disabled).toBe(false);
      expect((screen.getByTestId("photo-down-0") as HTMLButtonElement).disabled).toBe(false);
    });

    it("disables BOTH directions for a single photo", async () => {
      await pickPhotos(1);
      expect((screen.getByTestId("photo-up-0") as HTMLButtonElement).disabled).toBe(true);
      expect((screen.getByTestId("photo-down-0") as HTMLButtonElement).disabled).toBe(true);
    });

    it("swaps a two-photo set", async () => {
      await pickPhotos(2);
      const before = stripOrder();
      fireEvent.click(screen.getByTestId("photo-up-1"));
      expect(stripOrder()).toEqual([before[1], before[0]]);
    });

    it("MOVES THE COVER BADGE when the reorder changes position 0", async () => {
      await pickPhotos(3);
      fireEvent.click(screen.getByTestId("photo-up-1"));
      // Still exactly one cover, and it is on the tile now at position 0.
      expect(screen.getAllByTestId("photo-cover")).toHaveLength(1);
      expect(within(screen.getByTestId("photo-tile-0")).getByTestId("photo-cover")).toBeTruthy();
    });

    it("SENDS CONTIGUOUS ORDER, AND THE MIRROR FOLLOWS, on save", async () => {
      // The ticket's headline hazard. Every existing client reads
      // post.media_url; if the reorder does not move it, the feed and the
      // member card show a different image than this preview promised.
      await pickPhotos(3);
      // Bring photo-2 (slot 2) to the very front: up twice.
      fireEvent.click(screen.getByTestId("photo-up-2"));
      fireEvent.click(screen.getByTestId("photo-up-1"));

      fireEvent.click(screen.getByTestId("primary-action"));
      await waitFor(() => expect(api.patchPost).toHaveBeenCalled());

      const sent = api.patchPost.mock.calls[0][1].media as string[];
      // Display order, and the route numbers these 0,1,2 — position 0 first.
      expect(sent).toEqual(["p1/photo-2", "p1/original", "p1/photo-1"]);
      // The route mirrors sent[0] into post.media_url, so asserting the head is
      // asserting the mirror. It is NOT p1/original any more.
      expect(sent[0]).toBe("p1/photo-2");
      expect(sent[0]).not.toBe("p1/original");
    });

    it("the big Step 3 frame and its caption follow the COVER, not the first file picked", async () => {
      // Found in the reorder screenshot, not by a test: the frame kept showing
      // `mediaUrl` (the first file picked, which never moves), so after a
      // reorder the screen said three different things at once — frame "photo
      // 1 / gallop-1.png", strip "photo 3 is the cover", card "photo 3".
      // Asserted on the caption line, not the <img>: jsdom has no
      // URL.createObjectURL, so `previewUrl` is null here and no image element
      // is rendered at all. The e2e screenshot is what proves the picture
      // itself follows; this pins the text that names it.
      await pickPhotos(3);
      expect(screen.getByTestId("media-filled").textContent).toContain("p1.jpg");

      // Bring photo 3 to the front.
      fireEvent.click(screen.getByTestId("photo-up-2"));
      fireEvent.click(screen.getByTestId("photo-up-1"));

      const zoneAfter = screen.getByTestId("media-filled").textContent ?? "";
      expect(zoneAfter).not.toContain("p1.jpg");
      expect(zoneAfter).toContain("p3.jpg");
      expect(zoneAfter).toContain("cover of 3");
      // And it agrees with the strip's cover tile.
      expect(within(screen.getByTestId("photo-tile-0")).getByTestId("photo-cover")).toBeTruthy();
    });

    it("leaves the set unchanged on save when nothing was reordered", async () => {
      await pickPhotos(3);
      fireEvent.click(screen.getByTestId("primary-action"));
      await waitFor(() => expect(api.patchPost).toHaveBeenCalled());
      expect(api.patchPost.mock.calls[0][1].media).toEqual([
        "p1/original",
        "p1/photo-1",
        "p1/photo-2",
      ]);
    });
  });

  describe("remove", () => {
    it("drops the tile and compacts the display order", async () => {
      await pickPhotos(3);
      const before = stripOrder();
      fireEvent.click(screen.getByTestId("photo-remove-1"));

      const after = stripOrder();
      expect(after).toHaveLength(2);
      expect(after).toEqual([before[0], before[2]]);
      // Renumbered, with no gap.
      expect(screen.getByTestId("photo-pos-0").textContent).toBe("1");
      expect(screen.getByTestId("photo-pos-1").textContent).toBe("2");
      expect(screen.queryByTestId("photo-tile-2")).toBeNull();
    });

    it("promotes a new cover when position 0 is removed, and saves it as the mirror", async () => {
      await pickPhotos(3);
      fireEvent.click(screen.getByTestId("photo-remove-0"));
      expect(within(screen.getByTestId("photo-tile-0")).getByTestId("photo-cover")).toBeTruthy();

      fireEvent.click(screen.getByTestId("primary-action"));
      await waitFor(() => expect(api.patchPost).toHaveBeenCalled());
      const sent = api.patchPost.mock.calls[0][1].media as string[];
      expect(sent).toEqual(["p1/photo-1", "p1/photo-2"]);
    });

    it("removing the last photo empties the strip and blocks the action", async () => {
      await pickPhotos(1);
      fireEvent.click(screen.getByTestId("photo-remove-0"));
      expect(screen.queryByTestId("photo-strip")).toBeNull();
      expect((screen.getByTestId("primary-action") as HTMLButtonElement).disabled).toBe(true);
    });
  });

  describe("a mid-way upload failure", () => {
    it("keeps the uploaded set, marks the failure, and offers a retry", async () => {
      api.createDraft.mockResolvedValue(draftWithSlots(3));
      api.patchPost.mockResolvedValue(undefined);
      api.publishPost.mockResolvedValue(undefined);
      // Photo 2 of 3 fails; the other two land.
      api.uploadPhotoToStorage
        .mockResolvedValueOnce(undefined)
        .mockRejectedValueOnce(new Error("network died"))
        .mockResolvedValueOnce(undefined);

      renderScreen();
      pickHorse("horse-opt-h1");
      selectType("photo");
      fireEvent.change(screen.getByTestId("media-input"), { target: { files: photoFiles(3) } });
      await waitFor(() => expect(api.uploadPhotoToStorage).toHaveBeenCalledTimes(3));

      // All three tiles survive; only the middle one is failed.
      expect(screen.getAllByTestId(/^photo-tile-\d+$/)).toHaveLength(3);
      expect(await screen.findByTestId("photo-retry-1")).toBeTruthy();
      expect(screen.queryByTestId("photo-retry-0")).toBeNull();

      // And the post is still publishable with the two that made it — the
      // failed photo is simply not persisted, so no post_media row can point at
      // an object that is not in Storage.
      fireEvent.click(screen.getByTestId("primary-action"));
      await waitFor(() => expect(api.patchPost).toHaveBeenCalled());
      expect(api.patchPost.mock.calls[0][1].media).toEqual(["p1/original", "p1/photo-2"]);
    });

    it("retry re-PUTs that photo to its own slot and clears the failure", async () => {
      api.createDraft.mockResolvedValue(draftWithSlots(2));
      api.uploadPhotoToStorage
        .mockResolvedValueOnce(undefined)
        .mockRejectedValueOnce(new Error("network died"));

      renderScreen();
      pickHorse("horse-opt-h1");
      selectType("photo");
      fireEvent.change(screen.getByTestId("media-input"), { target: { files: photoFiles(2) } });
      const retry = await screen.findByTestId("photo-retry-1");

      api.uploadPhotoToStorage.mockResolvedValueOnce(undefined);
      fireEvent.click(retry);
      await waitFor(() => expect(screen.queryByTestId("photo-retry-1")).toBeNull());
      // Same slot path, not a new one — no orphaned object.
      expect(api.uploadPhotoToStorage.mock.calls.at(-1)![0].path).toBe("p1/photo-1");
    });

    it("the cover skips a FAILED first photo, because the mirror will", async () => {
      api.createDraft.mockResolvedValue(draftWithSlots(2));
      api.uploadPhotoToStorage
        .mockRejectedValueOnce(new Error("network died"))
        .mockResolvedValueOnce(undefined);

      renderScreen();
      pickHorse("horse-opt-h1");
      selectType("photo");
      fireEvent.change(screen.getByTestId("media-input"), { target: { files: photoFiles(2) } });
      await waitFor(() => expect(api.uploadPhotoToStorage).toHaveBeenCalledTimes(2));

      // Position 0 failed, so post.media_url will land on photo-1 — and the
      // badge has to say so, or it promises the feed an image never stored.
      await waitFor(() =>
        expect(within(screen.getByTestId("photo-tile-1")).queryByTestId("photo-cover")).toBeTruthy(),
      );
      expect(within(screen.getByTestId("photo-tile-0")).queryByTestId("photo-cover")).toBeNull();
    });
  });

  describe("a non-photo file in the set", () => {
    it("rejects the whole pick and uploads nothing", async () => {
      renderScreen();
      pickHorse("horse-opt-h1");
      selectType("photo");
      const mixed = [
        new File([new Uint8Array([1])], "ok.jpg", { type: "image/jpeg" }),
        new File([new Uint8Array([2])], "clip.mp4", { type: "video/mp4" }),
      ];
      fireEvent.change(screen.getByTestId("media-input"), { target: { files: mixed } });

      const err = await screen.findByTestId("type-mismatch");
      expect(err.textContent).toContain("clip.mp4");
      expect(api.createDraft).not.toHaveBeenCalled();
      expect(api.uploadPhotoToStorage).not.toHaveBeenCalled();
    });
  });
});
