import { beforeEach, describe, expect, it, vi } from "vitest";
import { blankState, makeFakeClient, type FakeState } from "@/lib/testing/supabase-fake";

// ENG-1611 — the compose loader (`page.tsx`) had no test, so restoring the old
// post-level `resolveVideoPlayback` write (which writes `post`, then gets
// mirrored back over by the slot-0 trigger) left the whole suite green. This
// file drives the REAL loader — real `readPostVideoStatus`, real
// `resolveVideoPlayback` — against the shared supabase fake, and pins WHICH
// table it may write.
//
// Mocked: the auth gate (reaches next/headers), the Mux API client (never call
// real Mux in tests) and ComposeScreen (a client component; we only need the
// props the loader hands it).

const state = vi.hoisted(() => ({ current: null as FakeState | null }));

vi.mock("@/lib/auth/admin", () => ({
  requireAdminPage: vi.fn(async () => ({
    sb: makeFakeClient(state.current!),
    user: { id: "admin-1" },
  })),
}));

const mux = vi.hoisted(() => ({
  findMuxAssetByPassthrough: vi.fn(),
  listReadyMuxAssets: vi.fn(),
}));
vi.mock("@/lib/mux", () => mux);

vi.mock("./ComposeScreen", () => ({ default: vi.fn(() => null) }));

import ComposePage from "./page";

const POST = {
  id: "post-1",
  type: "video",
  status: "draft",
  title: null,
  body: "caption",
  label: null,
  subject: "horse",
  byline: null,
  source_trainer_id: null,
  scheduled_for: null,
  media_url: null,
  // NULL on `post` (the webhook lags) while Mux DOES have the post.id asset:
  // exactly the case the old post-level write would fire in.
  mux_playback_id: null,
  horse: null,
  source_trainer: null,
};

function stateWith(postVideo: FakeState["tables"][string]): FakeState {
  const s = blankState();
  s.user = { id: "admin-1" };
  s.tables.post = { select: { single: POST } };
  s.tables.post_video = postVideo;
  return s;
}

async function load() {
  const el = (await ComposePage({ searchParams: Promise.resolve({ id: POST.id }) })) as {
    props: { initial?: { videos?: unknown[]; videosUnavailable?: boolean } };
  };
  return el.props;
}

const writesTo = (table: string) =>
  state.current!.calls.mutations.filter((m) => m.table === table && m.op !== "delete");

beforeEach(() => {
  mux.findMuxAssetByPassthrough.mockReset();
  mux.listReadyMuxAssets.mockReset();
  mux.findMuxAssetByPassthrough.mockResolvedValue({ assetId: "as_post", playbackId: "pb_post" });
  mux.listReadyMuxAssets.mockResolvedValue([]);
});

describe("compose page loader — ENG-1611", () => {
  it("when post_video exists, the loader never writes `post` (only the slot-0 mirror may)", async () => {
    state.current = stateWith({
      select: {
        rows: [
          {
            id: "pv-0",
            sort_order: 0,
            status: "ready",
            mux_upload_id: "up-0",
            mux_playback_id: "pb_row",
            poster_url: null,
            created_at: "2024-01-01T00:00:00.000Z",
          },
        ],
      },
    });
    const props = await load();
    expect(props.initial?.videos).toHaveLength(1);
    expect(props.initial?.videosUnavailable).toBe(false);
    expect(writesTo("post")).toEqual([]);
    // …and the post-level Mux lookup was never asked.
    expect(mux.findMuxAssetByPassthrough).not.toHaveBeenCalled();
  });

  it("when post_video exists and a legacy row reconciles, the write lands on post_video — never on post", async () => {
    mux.listReadyMuxAssets.mockResolvedValue([
      { assetId: "as_post", playbackId: "pb_post", passthrough: POST.id, aspectRatio: null },
    ]);
    state.current = stateWith({
      select: {
        rows: [
          {
            id: "pv-legacy",
            sort_order: 0,
            status: "uploading",
            mux_upload_id: null,
            mux_playback_id: null,
            poster_url: null,
            created_at: "2024-01-01T00:00:00.000Z",
          },
        ],
      },
      mutate: { rows: [{ id: "pv-legacy" }] },
    });
    await load();
    expect(writesTo("post")).toEqual([]);
    expect(writesTo("post_video")).toHaveLength(1);
  });

  it("pre-migration (post_video missing): the post-level reconcile still writes `post`, guarded only-if-null", async () => {
    state.current = stateWith({ select: { error: { code: "42P01", message: "relation does not exist" } } });
    const props = await load();
    expect(props.initial?.videosUnavailable).toBe(true);
    const w = writesTo("post");
    expect(w).toHaveLength(1);
    expect(w[0].payload).toEqual({ mux_asset_id: "as_post", mux_playback_id: "pb_post" });
    expect(w[0].filters).toEqual([
      { column: "id", value: POST.id },
      { column: "mux_playback_id", value: null, op: "is" },
    ]);
  });

  it("a failed post_video read (not a missing table) writes nothing at all", async () => {
    state.current = stateWith({ select: { error: { code: "XX000", message: "boom" } } });
    vi.spyOn(console, "error").mockImplementation(() => {});
    const props = await load();
    expect(props.initial?.videosUnavailable).toBe(true);
    expect(state.current.calls.mutations).toEqual([]);
  });
});
