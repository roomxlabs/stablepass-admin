#!/usr/bin/env node
// Launch reset CLI (ENG-984). Run DELIBERATELY, BY A HUMAN, before go-live —
// this is NEVER wired into deploy, CI or a migration. It wipes accumulated
// analytics/engagement rows so Mel and Justin's weeks of testing don't
// pollute day-one numbers.
//
// `lib/analytics/reset.ts` is the tested source of truth for the table list
// and timestamp columns. This CLI duplicates only that small literal (it
// can't import the .ts module directly without a TS loader). The duplication
// is not left to trust: `lib/analytics/reset.test.ts` parses THIS FILE and
// fails if the two ever drift.
//
// Usage:
//   node scripts/reset-analytics.mjs --project-ref=<ref>              (dry run)
//   node scripts/reset-analytics.mjs --confirm --project-ref=<ref>    (for real)
import { createClient } from "@supabase/supabase-js";

// Keep in step with lib/analytics/reset.ts RESET_TABLES / TS_COLUMN.
const RESET_TABLES = ["impression", "reaction", "bookmark", "trainer_website_click"];
const TS_COLUMN = {
  impression: "seen_at",
  reaction: "created_at",
  bookmark: "created_at",
  trainer_website_click: "clicked_at",
};

function parseArgs(argv) {
  const confirm = argv.includes("--confirm");
  const refArg = argv.find((a) => a.startsWith("--project-ref="));
  const projectRef = refArg ? refArg.slice("--project-ref=".length) : null;
  return { confirm, projectRef };
}

function deriveProjectRef(url) {
  const host = new URL(url).hostname;
  if (host === "localhost" || host === "127.0.0.1") return "local";
  const m = /^([^.]+)\.supabase\.co$/.exec(host);
  return m ? m[1] : host;
}

function banner(url, ref) {
  console.log("=== StablePass analytics reset ===");
  // The target is printed on EVERY run, dry or confirmed. Without it a
  // destructive run never tells the operator which database it just hit.
  console.log(`Target: ${new URL(url).host}  (project ref: ${ref})`);
  console.log(`Tables cleared: ${RESET_TABLES.join(", ")}`);
  console.log(
    "Not touched: app_user, subscription, horse, trainer, follow — and no post ROW is deleted.",
  );
  // This is the one sentence in a destructive script that has to be true.
  // Deleting `reaction` rows fires the BE's `reaction_like_count` trigger
  // (after insert or delete, per row), which decrements `post.like_count`. So
  // this reset DOES write post.like_count, driving it to 0. That is the
  // intended outcome — launch starts from zero — but it is a write outside the
  // four tables and must be stated, not discovered.
  console.log(
    "Side effect: clearing `reaction` drives post.like_count to 0 via the reaction_like_count trigger (intended).",
  );
  console.log("");
}

async function countRows(sb, table) {
  // Counted on the TIMESTAMP COLUMN the delete will actually filter on, not on
  // `*`. Counting `*` proves only that the table exists; if a timestamp column
  // were wrong or missing, the first three tables would already be deleted
  // before the fourth failed, leaving a half-cleared database. This makes the
  // pre-flight validate the real predicate column for every table up front.
  const { count, error } = await sb
    .from(table)
    .select(TS_COLUMN[table], { count: "exact", head: true });
  if (error) {
    throw new Error(
      `could not count "${table}" on its delete column "${TS_COLUMN[table]}": ${error.message}`,
    );
  }
  return count ?? 0;
}

async function main() {
  const { confirm, projectRef } = parseArgs(process.argv.slice(2));

  const url = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url) {
    console.error("Missing SUPABASE_URL in the environment.");
    process.exit(1);
  }
  if (!serviceKey) {
    console.error("Missing SUPABASE_SERVICE_ROLE_KEY in the environment.");
    process.exit(1);
  }

  // TYPE-TO-CONFIRM GUARD. This proves the operator can name the project they
  // are about to wipe; it does NOT independently verify that SUPABASE_URL is
  // the project they meant. Deliberately it does not print the derived ref on
  // a mismatch — echoing it would hand over the very answer being asked for,
  // turning the gate into a copy-paste prompt.
  const derivedRef = deriveProjectRef(url);
  if (!projectRef || projectRef !== derivedRef) {
    console.error(
      "Refusing to run: --project-ref must be passed and must match the project SUPABASE_URL points at.",
    );
    console.error(`  --project-ref given: ${projectRef ?? "(none)"}`);
    // Neither the derived ref NOR the host is printed. Both hand over the
    // answer (the ref is just the host's first label), which would turn a
    // type-to-confirm into a copy-paste prompt. The ref is not a secret — it
    // sits in the operator's own env — so the point is not concealment; it is
    // forcing a deliberate look at an independent source instead of a reflex
    // paste from an error message.
    console.error(
      "  It does not match the project SUPABASE_URL points at. Check which project you are aimed at\n" +
        "  (`echo $SUPABASE_URL`) and take the ref you intend from the Supabase dashboard or the runbook.",
    );
    process.exit(1);
  }

  banner(url, derivedRef);

  const sb = createClient(url, serviceKey, { auth: { persistSession: false } });

  const plan = [];
  for (const table of RESET_TABLES) plan.push({ table, rows: await countRows(sb, table) });

  const total = plan.reduce((sum, p) => sum + p.rows, 0);
  for (const p of plan) console.log(`  ${p.table.padEnd(24)} ${p.rows}`);
  console.log(`  ${"total".padEnd(24)} ${total}`);
  console.log("");

  if (!confirm) {
    console.log("Dry run — no rows deleted.");
    console.log(`Re-run with --confirm --project-ref=${projectRef} to delete these rows for real.`);
    process.exit(0);
  }

  for (const table of RESET_TABLES) {
    // PostgREST refuses an unqualified DELETE, so a filter is required; `gte`
    // on the row's own timestamp column matches every row (all four columns are
    // `timestamptz not null default now()` in the BE schema, so none can escape).
    const { error } = await sb.from(table).delete().gte(TS_COLUMN[table], "1970-01-01T00:00:00Z");
    // THROW rather than exit here, so the top-level catch's partial-delete
    // warning fires. A mid-loop failure is the single most likely way to end up
    // half-cleared, which is exactly when that warning matters most.
    if (error) throw new Error(`could not delete rows from "${table}": ${error.message}`);
  }

  // Report what was OBSERVED, not what was planned. Re-counting is the only
  // thing that distinguishes "deleted" from "attempted to delete".
  console.log("Deleted (before -> after):");
  let remaining = 0;
  for (const p of plan) {
    const after = await countRows(sb, p.table);
    remaining += after;
    console.log(`  ${p.table.padEnd(24)} ${p.rows} -> ${after}${after === 0 ? "" : "   ** NOT EMPTY **"}`);
  }

  if (remaining !== 0) {
    console.error(`\n${remaining} row(s) survived the reset. Investigate before launch.`);
    process.exit(1);
  }
  console.log("\nAll engagement/analytics rows cleared.");
  process.exit(0);
}

// A destructive script must never fail as a raw unhandled rejection: the stack
// trace alone would leave the operator unsure whether anything was deleted.
// Exit non-zero with a plain message instead.
main().catch((e) => {
  console.error(`Reset aborted: ${e instanceof Error ? e.message : String(e)}`);
  console.error(
    "If this happened after the counts were printed, some tables may already have been cleared — re-run the dry run to see the current state.",
  );
  process.exit(1);
});
