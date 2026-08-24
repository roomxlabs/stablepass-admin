import { describe, it, expect, beforeEach, vi } from "vitest";
import { makeFakeClient, blankState, type FakeState } from "@/lib/testing/supabase-fake";
import { POST_LABEL_PRESETS } from "@/lib/posts/labels";

const state: FakeState = blankState();

vi.mock("@/lib/supabase/server", () => ({
  supabaseServer: async () => makeFakeClient(state),
}));
const createMuxDirectUpload = vi.fn<
  (opts?: { passthrough?: string }) => Promise<{ uploadId: string; uploadUrl: string }>
>(async () => ({ uploadId: "up_123", uploadUrl: "https://mux.local/upload" }));
vi.mock("@/lib/mux", () => ({
  MuxError: class MuxError extends Error {},
  createMuxDirectUpload: (opts?: { passthrough?: string }) => createMuxDirectUpload(opts),
}));

import { GET, POST } from "./route";

function asAdmin() {
  state.user = { id: "u1" };
  state.tables.app_user = { select: { single: { is_admin: true } } };
}
function asNonAdmin() {
  state.user = { id: "u1" };
  state.tables.app_user = { select: { single: { is_admin: false } } };
}
function postReq(body: unknown): Request {
  return new Request("http://t/api/admin/posts", { method: "POST", body: JSON.stringify(body) });
}

beforeEach(() => {
  Object.assign(state, blankState());
  // ENG-611: several new tests assert createMuxDirectUpload was NOT called
  // (text never touches Mux) — clear call history per-test so an earlier
  // test's video draft can't leak into that assertion.
  createMuxDirectUpload.mockClear();
});

describe("POST /api/admin/posts — create draft", () => {
  it("403s for a non-admin (guardrail)", async () => {
    asNonAdmin();
    const r = await POST(postReq({ horseId: "h1", type: "photo", sourceTrainerId: "t1" }));
    expect(r.status).toBe(403);
  });

  it("creates a photo draft → 202 + Storage upload target", async () => {
    asAdmin();
    state.tables.horse = { select: { single: { id: "h1" } } };
    state.tables.post = { mutate: { single: { id: "p1", status: "draft", type: "photo", horse_id: "h1" } } };
    const r = await POST(postReq({ horseId: "h1", type: "photo", sourceTrainerId: "t1", title: "Win" }));
    expect(r.status).toBe(202);
    const j = await r.json();
    expect(j.data.id).toBe("p1");
    expect(j.data.status).toBe("draft");
    expect(j.data.watermarked).toBe(false);
    expect(j.data.uploadUrl).toContain("post-media");
    expect(j.data.bucket).toBe("post-media");
  });

  it("creates a video draft → 202 + Mux direct-upload URL", async () => {
    asAdmin();
    state.tables.horse = { select: { single: { id: "h1" } } };
    state.tables.post = { mutate: { single: { id: "p2", status: "draft", type: "video", horse_id: "h1" } } };
    const r = await POST(postReq({ horseId: "h1", type: "video", sourceTrainerId: "t1" }));
    expect(r.status).toBe(202);
    const j = await r.json();
    expect(j.data.uploadUrl).toBe("https://mux.local/upload");
    expect(j.data.muxUploadId).toBe("up_123");
  });

  it("passes passthrough = post id to Mux (webhook reconcile contract)", async () => {
    asAdmin();
    state.tables.horse = { select: { single: { id: "h1" } } };
    state.tables.post = { mutate: { single: { id: "p2", status: "draft", type: "video", horse_id: "h1" } } };
    await POST(postReq({ horseId: "h1", type: "video", sourceTrainerId: "t1" }));
    expect(createMuxDirectUpload).toHaveBeenCalledWith(expect.objectContaining({ passthrough: "p2" }));
  });

  it("rejects 'news' → 400", async () => {
    asAdmin();
    const r = await POST(postReq({ horseId: "h1", type: "news", sourceTrainerId: "t1" }));
    expect(r.status).toBe(400);
  });

  // ENG-611 — non-admin gate on all four creatable types (guardrail).
  it.each(["video", "photo", "voice", "text"] as const)(
    "403s for a non-admin — type '%s'",
    async (type) => {
      asNonAdmin();
      const body: Record<string, unknown> = { horseId: "h1", type, sourceTrainerId: "t1" };
      // text needs a body too, so the 403 is provably the admin gate and not
      // a 400 from validation.
      if (type === "text") body.body = "Stable update text";
      const r = await POST(postReq(body));
      expect(r.status).toBe(403);
      // The status code alone is a weak guardrail proof. Nothing may be
      // written, signed or sent to Mux before the gate rejects the caller.
      expect(state.calls.mutations).toHaveLength(0);
      expect(state.calls.storage).toHaveLength(0);
      expect(createMuxDirectUpload).not.toHaveBeenCalled();
    },
  );

  // ENG-611 — an AAL1 admin is refused on the WRITE path too. The fake defaults
  // to aal2, so this case has to opt in explicitly or it silently tests aal2.
  it.each(["video", "photo", "voice", "text"] as const)(
    "403s mfa_required for an AAL1 admin — type '%s'",
    async (type) => {
      asAdmin();
      state.aal = "aal1";
      const body: Record<string, unknown> = { horseId: "h1", type, sourceTrainerId: "t1" };
      if (type === "text") body.body = "Stable update text";
      const r = await POST(postReq(body));
      expect(r.status).toBe(403);
      const j = await r.json();
      expect(j.error.code).toBe("mfa_required");
      expect(state.calls.mutations).toHaveLength(0);
      expect(state.calls.storage).toHaveLength(0);
      expect(createMuxDirectUpload).not.toHaveBeenCalled();
    },
  );

  // A horse is required for EVERY type, text included (post.horse_id is NOT NULL).
  it("400s a text post with no horse", async () => {
    asAdmin();
    const r = await POST(postReq({ type: "text", body: "Stable update text", sourceTrainerId: "t1" }));
    expect(r.status).toBe(400);
    const j = await r.json();
    expect(j.error.code).toBe("validation_failed");
    expect(state.calls.mutations).toHaveLength(0);
  });

  // ENG-611 — voice reuses the photo Storage path exactly.
  it("creates a voice draft → 202 + Storage upload target", async () => {
    asAdmin();
    state.tables.horse = { select: { single: { id: "h1" } } };
    state.tables.post = { mutate: { single: { id: "p3", status: "draft", type: "voice", horse_id: "h1" } } };
    const r = await POST(postReq({ horseId: "h1", type: "voice", sourceTrainerId: "t1" }));
    expect(r.status).toBe(202);
    const j = await r.json();
    expect(j.data.uploadUrl).toContain("post-media");
    expect(j.data.bucket).toBe("post-media");
    expect(state.calls.storage).toContainEqual({ bucket: "post-media", path: "p3/original" });
    // Voice goes to Storage and NOWHERE near Mux (guardrail: media split).
    expect(createMuxDirectUpload).not.toHaveBeenCalled();
    // ...and the row really was inserted as a voice post.
    expect(state.calls.mutations).toContainEqual(
      expect.objectContaining({
        table: "post",
        op: "insert",
        payload: expect.objectContaining({ type: "voice", horse_id: "h1", status: "draft" }),
      }),
    );
  });

  it("records media_url on the draft before returning (voice)", async () => {
    asAdmin();
    state.tables.horse = { select: { single: { id: "h1" } } };
    state.tables.post = { mutate: { single: { id: "p3", status: "draft", type: "voice", horse_id: "h1" } } };
    await POST(postReq({ horseId: "h1", type: "voice", sourceTrainerId: "t1" }));
    expect(state.calls.mutations).toContainEqual(
      expect.objectContaining({
        table: "post",
        op: "update",
        payload: { media_url: "p3/original" },
        // ...and it updated THAT row, not an unfiltered UPDATE over the table.
        filters: expect.arrayContaining([{ column: "id", value: "p3" }]),
      }),
    );
  });

  it("voice storage failure rolls the draft back → 502 storage_unavailable", async () => {
    asAdmin();
    state.tables.horse = { select: { single: { id: "h1" } } };
    state.tables.post = { mutate: { single: { id: "p3", status: "draft", type: "voice", horse_id: "h1" } } };
    state.storage.signed = { data: null, error: { message: "nope" } };
    const r = await POST(postReq({ horseId: "h1", type: "voice", sourceTrainerId: "t1" }));
    expect(r.status).toBe(502);
    const j = await r.json();
    expect(j.error.code).toBe("storage_unavailable");
    // Scoped, not a bare DELETE: it must target this draft id AND status
    // 'draft', so a concurrent publish can never be hard-deleted (guardrail 2).
    expect(state.calls.mutations).toContainEqual(
      expect.objectContaining({
        table: "post",
        op: "delete",
        filters: expect.arrayContaining([
          { column: "id", value: "p3" },
          { column: "status", value: "draft" },
        ]),
      }),
    );
  });

  // ENG-611 — text carries no asset: no upload target, no Storage/Mux call,
  // no rollback for the upload target it was never supposed to have.
  it("creates a text draft → 202 with no upload target, no storage/mux call, no rollback", async () => {
    asAdmin();
    state.tables.horse = { select: { single: { id: "h1" } } };
    state.tables.post = { mutate: { single: { id: "p4", status: "draft", type: "text", horse_id: "h1" } } };
    const r = await POST(
      postReq({ horseId: "h1", type: "text", sourceTrainerId: "t1", body: "Stable update text" }),
    );
    expect(r.status).toBe(202);
    const j = await r.json();
    expect(j.data.uploadUrl).toBeUndefined();
    expect(state.calls.storage.length).toBe(0);
    expect(createMuxDirectUpload).not.toHaveBeenCalled();
    expect(state.calls.mutations.some((m) => m.op === "delete")).toBe(false);
  });

  it("400 validation_failed when a text post's body is empty/whitespace", async () => {
    asAdmin();
    const r = await POST(postReq({ horseId: "h1", type: "text", sourceTrainerId: "t1", body: "   " }));
    expect(r.status).toBe(400);
    const j = await r.json();
    expect(j.error.code).toBe("validation_failed");
  });

  it("400 validation_failed when a text post's body is missing entirely", async () => {
    asAdmin();
    const r = await POST(postReq({ horseId: "h1", type: "text", sourceTrainerId: "t1" }));
    expect(r.status).toBe(400);
    const j = await r.json();
    expect(j.error.code).toBe("validation_failed");
  });

  it("text insert carries the body and type", async () => {
    asAdmin();
    state.tables.horse = { select: { single: { id: "h1" } } };
    state.tables.post = { mutate: { single: { id: "p4", status: "draft", type: "text", horse_id: "h1" } } };
    await POST(
      postReq({ horseId: "h1", type: "text", sourceTrainerId: "t1", body: "Stable update text" }),
    );
    const insertCall = state.calls.mutations.find((m) => m.table === "post" && m.op === "insert");
    expect(insertCall?.payload).toMatchObject({ body: "Stable update text", type: "text" });
  });

  // ENG-611 — all four creatable types succeed end to end.
  it.each(["video", "photo", "voice", "text"] as const)("accepts type '%s' → 202", async (type) => {
    asAdmin();
    state.tables.horse = { select: { single: { id: "h1" } } };
    state.tables.post = { mutate: { single: { id: "p5", status: "draft", type, horse_id: "h1" } } };
    const body: Record<string, unknown> = { horseId: "h1", type, sourceTrainerId: "t1" };
    if (type === "text") body.body = "Stable update text";
    const r = await POST(postReq(body));
    expect(r.status).toBe(202);
  });

  it("404 horse_not_found when the horse does not exist", async () => {
    asAdmin();
    state.tables.horse = { select: { single: null } };
    const r = await POST(postReq({ horseId: "nope", type: "photo", sourceTrainerId: "t1" }));
    expect(r.status).toBe(404);
    const j = await r.json();
    expect(j.error.code).toBe("horse_not_found");
  });

  it("400 when required fields are missing", async () => {
    asAdmin();
    const r = await POST(postReq({ type: "photo" }));
    expect(r.status).toBe(400);
  });

  // ENG-745 — post-label presets.
  it("label absent → insert carries label: null", async () => {
    asAdmin();
    state.tables.horse = { select: { single: { id: "h1" } } };
    state.tables.post = { mutate: { single: { id: "p1", status: "draft", type: "photo", horse_id: "h1" } } };
    await POST(postReq({ horseId: "h1", type: "photo", sourceTrainerId: "t1" }));
    const insertCall = state.calls.mutations.find((m) => m.table === "post" && m.op === "insert");
    expect(insertCall?.payload).toMatchObject({ label: null });
  });

  it("a valid preset label → insert carries that exact string", async () => {
    asAdmin();
    state.tables.horse = { select: { single: { id: "h1" } } };
    state.tables.post = { mutate: { single: { id: "p1", status: "draft", type: "photo", horse_id: "h1" } } };
    await POST(postReq({ horseId: "h1", type: "photo", sourceTrainerId: "t1", label: "Trackwork" }));
    const insertCall = state.calls.mutations.find((m) => m.table === "post" && m.op === "insert");
    expect(insertCall?.payload).toMatchObject({ label: "Trackwork" });
  });

  it.each([null, ""] as const)("explicit label %j → insert carries null", async (label) => {
    asAdmin();
    state.tables.horse = { select: { single: { id: "h1" } } };
    state.tables.post = { mutate: { single: { id: "p1", status: "draft", type: "photo", horse_id: "h1" } } };
    await POST(postReq({ horseId: "h1", type: "photo", sourceTrainerId: "t1", label }));
    const insertCall = state.calls.mutations.find((m) => m.table === "post" && m.op === "insert");
    expect(insertCall?.payload).toMatchObject({ label: null });
  });

  it("an off-list label ('Betting Tips') → 400 validation_failed, no insert attempted", async () => {
    asAdmin();
    const r = await POST(
      postReq({ horseId: "h1", type: "photo", sourceTrainerId: "t1", label: "Betting Tips" }),
    );
    expect(r.status).toBe(400);
    const j = await r.json();
    expect(j.error.code).toBe("validation_failed");
    expect(state.calls.mutations).toHaveLength(0);
  });

  it("a hyphen near-miss ('Race Day - Today') → 400 validation_failed", async () => {
    asAdmin();
    const r = await POST(
      postReq({ horseId: "h1", type: "photo", sourceTrainerId: "t1", label: "Race Day - Today" }),
    );
    expect(r.status).toBe(400);
    const j = await r.json();
    expect(j.error.code).toBe("validation_failed");
    expect(state.calls.mutations).toHaveLength(0);
  });

  it("the middle-dot preset ('Race Day · Today') is accepted", async () => {
    asAdmin();
    // Copied off the preset list itself (not retyped) — the separator is the
    // byte-exact U+00B7 MIDDLE DOT, not a hyphen.
    const label = POST_LABEL_PRESETS.find((p) => p.includes("Race Day"));
    state.tables.horse = { select: { single: { id: "h1" } } };
    state.tables.post = { mutate: { single: { id: "p1", status: "draft", type: "photo", horse_id: "h1" } } };
    const r = await POST(postReq({ horseId: "h1", type: "photo", sourceTrainerId: "t1", label }));
    expect(r.status).toBe(202);
    const insertCall = state.calls.mutations.find((m) => m.table === "post" && m.op === "insert");
    expect(insertCall?.payload).toMatchObject({ label });
  });

  it("insert violating the label CHECK (23514) → 400 validation_failed, not insert_failed", async () => {
    asAdmin();
    state.tables.horse = { select: { single: { id: "h1" } } };
    // Postgres names the constraint in the message; PostgREST passes it through.
    state.tables.post = {
      mutate: {
        error: {
          code: "23514",
          message: 'new row for relation "post" violates check constraint "post_label_preset"',
        },
      },
    };
    const r = await POST(
      postReq({ horseId: "h1", type: "photo", sourceTrainerId: "t1", label: "Trackwork" }),
    );
    expect(r.status).toBe(400);
    const j = await r.json();
    expect(j.error.code).toBe("validation_failed");
    expect(j.error.message).toContain("13 presets");
  });

  // Scoped by constraint NAME: `post` also CHECKs type/status/aspect_ratio and
  // they all raise 23514, so matching the bare code turned an unrelated
  // constraint failure into a misleading message about a field nobody sent.
  it("a 23514 from a DIFFERENT constraint keeps its own message", async () => {
    asAdmin();
    state.tables.horse = { select: { single: { id: "h1" } } };
    state.tables.post = {
      mutate: {
        error: {
          code: "23514",
          message:
            'new row for relation "post" violates check constraint "post_aspect_ratio_positive"',
        },
      },
    };
    const r = await POST(postReq({ horseId: "h1", type: "photo", sourceTrainerId: "t1" }));
    expect(r.status).toBe(400);
    const j = await r.json();
    expect(j.error.code).toBe("insert_failed");
    expect(j.error.message).toContain("post_aspect_ratio_positive");
    expect(j.error.message).not.toContain("13 presets");
  });

  it("403s for a non-admin sending a label — never reaches the DB", async () => {
    asNonAdmin();
    const r = await POST(
      postReq({ horseId: "h1", type: "photo", sourceTrainerId: "t1", label: "Trackwork" }),
    );
    expect(r.status).toBe(403);
    expect(state.calls.mutations).toHaveLength(0);
  });
});

describe("GET /api/admin/posts — list + search", () => {
  it("403s for a non-admin (guardrail)", async () => {
    asNonAdmin();
    const r = await GET(new Request("http://t/api/admin/posts"));
    expect(r.status).toBe(403);
  });

  it("returns the list with meta for an admin", async () => {
    asAdmin();
    state.tables.post = { select: { rows: [{ id: "p1" }, { id: "p2" }], count: 2 } };
    const r = await GET(new Request("http://t/api/admin/posts"));
    expect(r.status).toBe(200);
    const j = await r.json();
    expect(j.data).toHaveLength(2);
    expect(j.meta.count).toBe(2);
  });

  it("?q= applies an ILIKE search over title/body + joined horse/trainer names", async () => {
    asAdmin();
    state.tables.horse = { select: { rows: [{ id: "h1" }] } };
    state.tables.trainer = { select: { rows: [{ id: "t1" }] } };
    state.tables.post = { select: { rows: [{ id: "p1", title: "Melbourne win" }], count: 1 } };
    const r = await GET(new Request("http://t/api/admin/posts?q=melb"));
    expect(r.status).toBe(200);
    const orExpr = state.calls.or.join(" | ");
    expect(orExpr).toContain("title.ilike.%melb%");
    expect(orExpr).toContain("body.ilike.%melb%");
    expect(orExpr).toContain("horse_id.in.(h1)");
    expect(orExpr).toContain("source_trainer_id.in.(t1)");
  });

  // ENG-745 — the fake's builder doesn't record the `.select(...)` column
  // string, so this proves the pass-through the select is FOR: a row carrying
  // `label` comes back through the envelope unchanged.
  it("returns a scripted row's label through the envelope unchanged", async () => {
    asAdmin();
    state.tables.post = {
      select: { rows: [{ id: "p1", label: "Trackwork" }, { id: "p2", label: null }], count: 2 },
    };
    const r = await GET(new Request("http://t/api/admin/posts"));
    expect(r.status).toBe(200);
    const j = await r.json();
    expect(j.data[0].label).toBe("Trackwork");
    expect(j.data[1].label).toBeNull();
  });
});
