// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import ComposeScreen from "./ComposeScreen";
import type { EditInitial, HorseOption, TrainerOption } from "./types";

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

    await waitFor(() =>
      expect(screen.getByTestId("preview-readout").textContent).toBe(
        "1080×1920 · Portrait 9:16 · Members see it cropped to 4:5",
      ),
    );
    expect(screen.getByTestId("preview-media").style.aspectRatio).toBe("0.8");
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
