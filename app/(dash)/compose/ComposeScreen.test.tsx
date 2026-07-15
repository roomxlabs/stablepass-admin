// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
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
  },
  {
    id: "h2",
    name: "Black Caviar",
    photoUrl: null,
    stableName: "Caulfield",
    trainerId: "t2",
    trainerName: "Peter Moody",
  },
];

function renderScreen() {
  return render(<ComposeScreen horses={HORSES} trainers={TRAINERS} />);
}

function pickHorse(testId: string) {
  fireEvent.change(screen.getByTestId("horse-search"), { target: { value: "Mah" } });
  fireEvent.click(screen.getByTestId(testId));
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
    fireEvent.click(screen.getAllByRole("radio")[1]);
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
