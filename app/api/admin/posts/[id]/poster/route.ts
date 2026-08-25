import { requireAdmin } from "@/lib/auth/admin";
import { ok, fail } from "@/lib/api/envelope";
import { POST_MEDIA_BUCKET, PHOTO_SIGN_TTL, signPhoto } from "@/lib/storage/photos";

// POST /api/admin/posts/:id/poster — re-bake the video poster at `{ time }`
// (seconds) via the BE `rebake-poster` edge function (ENG-823).
//
// Guardrail 1: requireAdmin() (admin + AAL2). The edge fn re-checks admin+AAL2.
// Guardrail 8: no Mux URL or service-role key leaves this BFF — we only return
// the private object path (+ a short-lived signed display URL) and a time.
//
// On BE failure the edge fn does not update `poster_url` / `poster_time_s`, so
// the previous poster stays intact (no partial write).

type RebakeOk = { data?: { posterUrl?: string; posterTimeS?: number } };
type RebakeErr = { error?: { code?: string; message?: string } };

function mapRebakeFailure(
  status: number | undefined,
  body: RebakeErr | null,
): { code: string; message: string; http: number } {
  const code = body?.error?.code;
  if (status === 403 || code === "forbidden") {
    return { code: "forbidden", message: "Admin access required.", http: 403 };
  }
  if (status === 404 || code === "not_found") {
    return { code: "not_found", message: "Video post not found or has no playable asset.", http: 404 };
  }
  if (status === 400 || code === "invalid_request") {
    return { code: "validation_failed", message: "time must be a finite number of seconds.", http: 400 };
  }
  return {
    code: "rebake_failed",
    message: body?.error?.message ?? "Poster re-bake failed. The previous poster was left unchanged.",
    http: status && status >= 400 && status < 600 ? status : 500,
  };
}

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const g = await requireAdmin();
  if ("res" in g) return g.res;
  const { sb } = g;
  const { id } = await params;

  let time: unknown;
  try {
    const body = (await req.json()) as { time?: unknown };
    time = body?.time;
  } catch {
    return fail("validation_failed", "Request body must be JSON with { time }.", 400);
  }

  if (typeof time !== "number" || !Number.isFinite(time) || time < 0) {
    return fail("validation_failed", "time must be a non-negative finite number.", 400);
  }

  const { data, error } = await sb.functions.invoke("rebake-poster", {
    body: { postId: id, time },
  });

  if (error) {
    // supabase-js sets error on non-2xx; the JSON body (if any) is often still
    // in `data`. Prefer an explicit status from FunctionsHttpError.context.
    const ctx = (error as { context?: Response }).context;
    const status = ctx?.status;
    const body = (data as RebakeErr | null) ?? null;
    const mapped = mapRebakeFailure(status, body);
    return fail(mapped.code, mapped.message, mapped.http);
  }

  const payload = (data as RebakeOk | null)?.data;
  const posterUrl = payload?.posterUrl;
  const posterTimeS = payload?.posterTimeS;
  if (typeof posterUrl !== "string" || typeof posterTimeS !== "number") {
    return fail("rebake_failed", "Poster re-bake returned an unexpected response.", 500);
  }

  // Best-effort signed URL so the library can swap the thumb without a full
  // navigation; signing failure does not undo the bake (path is already written).
  const posterDisplayUrl = await signPhoto(sb, POST_MEDIA_BUCKET, posterUrl, PHOTO_SIGN_TTL);

  return ok({ posterUrl, posterTimeS, posterDisplayUrl });
}
