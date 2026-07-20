// Racing match queue — the read side (RF4 / ENG-296).
//
// Shared by the `(dash)` screen (Server Component, gated by requireAdminPage)
// and `GET /api/admin/racing-matches` (gated by requireAdmin) so both project
// exactly one shape. `sb` is always the CALLER's RLS client — the
// horse_match_proposal_all_admin policy (RF1) is the second gate behind
// requireAdmin, never a service-role client.
//
// Reads are flat per-table + merged in JS rather than PostgREST embeds: there
// is no live backend to verify an embed against here (see .rx/gotchas.md).
import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * The ONLY evidence fields that may ever leave the BFF.
 *
 * Guardrail (no owner PII): `evidence` is jsonb written by the poller (RF3).
 * RF1 ships a `horse_match_proposal_no_owner_pii` CHECK that keeps `owner*`
 * out of the column, but the BFF does not trust the column alone — it
 * projects an explicit allowlist, so a future writer that slips an owner (or
 * any other) key past the constraint still cannot reach a client.
 */
export const EVIDENCE_FIELDS = ["name", "sire", "dam", "age", "sex", "colour", "trainer"] as const;
export type EvidenceField = (typeof EVIDENCE_FIELDS)[number];
export type MatchEvidence = Partial<Record<EvidenceField, string | number>>;

export type MatchProposal = {
  id: string;
  racingApiId: string;
  createdAt: string;
  horse: {
    id: string;
    displayName: string;
    racingName: string | null;
    sire: string | null;
    dam: string | null;
    foalingYear: number | null;
    sex: string | null;
    colour: string | null;
    trainer: string | null;
    /** Already-linked feed id, if any — a confirm against a different id is a 409. */
    racingApiId: string | null;
  };
  evidence: MatchEvidence;
};

type ProposalRow = {
  id: string;
  horse_id: string;
  racing_api_id: string;
  evidence: unknown;
  created_at: string;
};

type HorseRow = {
  id: string;
  display_name: string | null;
  racing_name: string | null;
  sire: string | null;
  dam: string | null;
  foaling_year: number | null;
  sex: string | null;
  colour: string | null;
  trainer_id: string | null;
  racing_api_id: string | null;
};

type TrainerRow = { id: string; name: string | null; display_name: string | null };

/**
 * Project the allowlisted evidence fields only. Anything else in the jsonb —
 * owner, odds, an unknown future key — is dropped here and never serialized.
 */
export function pickEvidence(raw: unknown): MatchEvidence {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return {};
  const src = raw as Record<string, unknown>;
  const out: MatchEvidence = {};
  for (const key of EVIDENCE_FIELDS) {
    const v = src[key];
    if (typeof v === "string" || typeof v === "number") out[key] = v;
  }
  return out;
}

// A read that ignores `error` renders an RLS regression as a legitimately
// empty queue. Throw instead; the route maps it to a generic 500 (never
// e.message, which would leak SQL/schema text). See .rx/gotchas.md.
function unwrap<T>(res: { data: T; error: unknown }, what: string): T {
  if (res.error) throw new Error(`racing-matches: ${what} query failed`);
  return res.data;
}

/** Pending proposals, oldest first, each merged with its platform horse. */
export async function getPendingProposals(sb: SupabaseClient): Promise<MatchProposal[]> {
  const proposals =
    unwrap(
      await sb
        .from("horse_match_proposal")
        .select("id,horse_id,racing_api_id,evidence,created_at")
        .eq("status", "pending")
        .order("created_at", { ascending: true }),
      "proposals",
    ) ?? [];
  const rows = proposals as ProposalRow[];
  if (rows.length === 0) return [];

  const horseIds = [...new Set(rows.map((r) => r.horse_id))];
  const horses =
    (unwrap(
      await sb
        .from("horse")
        .select("id,display_name,racing_name,sire,dam,foaling_year,sex,colour,trainer_id,racing_api_id")
        .in("id", horseIds),
      "horses",
    ) as HorseRow[] | null) ?? [];
  const horseById = new Map(horses.map((h) => [h.id, h]));

  const trainerIds = [...new Set(horses.map((h) => h.trainer_id).filter((v): v is string => !!v))];
  const trainers = trainerIds.length
    ? ((unwrap(
        await sb.from("trainer").select("id,name,display_name").in("id", trainerIds),
        "trainers",
      ) as TrainerRow[] | null) ?? [])
    : [];
  const trainerById = new Map(trainers.map((t) => [t.id, t]));

  // A proposal whose horse row is missing (deleted mid-review) is dropped
  // rather than rendered half-empty.
  return rows.flatMap((p) => {
    const h = horseById.get(p.horse_id);
    if (!h) return [];
    const t = h.trainer_id ? trainerById.get(h.trainer_id) : undefined;
    return [
      {
        id: p.id,
        racingApiId: p.racing_api_id,
        createdAt: p.created_at,
        horse: {
          id: h.id,
          displayName: h.display_name ?? "Unnamed",
          racingName: h.racing_name,
          sire: h.sire,
          dam: h.dam,
          foalingYear: h.foaling_year,
          sex: h.sex,
          colour: h.colour,
          trainer: t?.display_name ?? t?.name ?? null,
          racingApiId: h.racing_api_id,
        },
        evidence: pickEvidence(p.evidence),
      },
    ];
  });
}

/** Age implied by the foaling year — never stored (schema note). */
export function ageFromFoalingYear(year: number | null, now = new Date()): number | null {
  if (!year) return null;
  return now.getFullYear() - year;
}

/** Normalized compare for the mismatch highlight — case/whitespace insensitive. */
export function valuesAgree(a: string | number | null, b: string | number | null): boolean {
  if (a === null || a === undefined || b === null || b === undefined) return false;
  return String(a).trim().toLowerCase() === String(b).trim().toLowerCase();
}
