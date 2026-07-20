// Presentation helpers for the manual-races screens (RF6 / ENG-180).
// Pure functions so they can be unit-tested without rendering.

export type RaceRow = {
  id: string;
  venue: string | null;
  race_date: string;
  race_number: number | null;
  race_class: string | null;
  distance_m: number | null;
  scheduled_at: string | null;
  status: string | null;
  source: string | null;
  manual_override: boolean | null;
  finished_at: string | null;
};

// "Randwick R5" — the operator's shorthand for a race event.
export function raceTitle(r: Pick<RaceRow, "venue" | "race_number">): string {
  const venue = r.venue ?? "Unknown venue";
  return r.race_number != null ? `${venue} R${r.race_number}` : venue;
}

// "Maiden · 1400m" — the secondary line; omits whichever part is missing.
export function raceMeta(r: Pick<RaceRow, "race_class" | "distance_m">): string {
  const parts: string[] = [];
  if (r.race_class) parts.push(r.race_class);
  if (r.distance_m != null) parts.push(`${r.distance_m}m`);
  return parts.join(" · ");
}

export function formatRaceDate(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(`${iso.slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString("en-AU", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  });
}

// Jump times MUST be pinned to a timezone. Left unpinned, this renders in the
// *server's* zone during SSR and the *browser's* on hydration — a React hydration
// mismatch, and for a UTC-deployed server an AU operator would read every jump time
// hours off. Racing operations run on Australian east-coast time, so that is the
// zone the operator is shown.
export const RACING_TZ = "Australia/Sydney";

export function formatJumpTime(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleTimeString("en-AU", {
    hour: "numeric",
    minute: "2-digit",
    timeZone: RACING_TZ,
  });
}

export function statusPill(status: string | null): { label: string; className: string } {
  return status === "finished"
    ? { label: "Finished", className: "pill" }
    : { label: "Upcoming", className: "pill green dot" };
}

// Provenance is the whole point of this screen: which rows the poll owns, which
// rows a human entered, and which feed rows a human has pinned.
export function sourcePill(
  r: Pick<RaceRow, "source" | "manual_override">,
): { label: string; className: string } {
  if (r.source === "manual") return { label: "Manual", className: "pill amber" };
  if (r.manual_override) return { label: "Feed · overridden", className: "pill green" };
  return { label: "Feed", className: "pill" };
}

export function runnerStatusPill(entryStatus: string | null): { label: string; className: string } {
  switch (entryStatus) {
    case "ran":
      return { label: "Ran", className: "pill green" };
    case "scratched":
      return { label: "Scratched", className: "pill red" };
    case "not_accepted":
      return { label: "Not accepted", className: "pill red" };
    case "nominated":
      return { label: "Nominated", className: "pill" };
    default:
      return { label: "Confirmed", className: "pill amber" };
  }
}

// Prize money is stored in cents (no floats). Display only — never an odds or
// wager value (guardrail: no betting fields anywhere in this surface).
export function formatPrize(cents: number | null | undefined): string {
  if (!cents) return "—";
  return `$${(cents / 100).toLocaleString("en-AU", { maximumFractionDigits: 0 })}`;
}
