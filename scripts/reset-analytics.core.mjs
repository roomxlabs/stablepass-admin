// Launch reset — the TESTABLE core of scripts/reset-analytics.mjs (ENG-984).
//
// WHY THIS FILE EXISTS
// --------------------
// Review of ENG-984 found that BOTH safety gates on this destructive script
// could be deleted with a fully green test suite:
//
//   A. the project-ref guard  (`if (!projectRef || projectRef !== derivedRef)`)
//   B. the dry-run default    (`if (!confirm)`)
//
// The only test covering them asserted that two STRINGS APPEARED IN THE CLI
// SOURCE, which survives both mutations untouched. A textual guard on a script
// that deletes four tables is not coverage — the gates are the whole thing
// standing between a runbook line and irreversible data loss, so they have to
// be exercised as BEHAVIOUR.
//
// The obstacle was that the gates lived inside `main()` in an executable
// `.mjs` with a live `createClient` and `process.exit` — nothing a test could
// call. So the logic moves here, as a plain module with every effect injected
// (argv, env, the client factory, the two output streams, and exit as a RETURN
// VALUE rather than a process kill). `reset-analytics.mjs` becomes a thin
// wrapper that supplies the real ones. The code that deletes production rows
// is now the same code the tests run.
//
// This is also .mjs rather than .ts on purpose: the CLI must keep running
// under a bare `node scripts/reset-analytics.mjs` with no TS loader, and
// vitest imports .mjs happily. That removes the hand-copied table literal the
// old drift-guard test existed to police — `lib/analytics/reset.test.ts` now
// compares the two modules' ACTUAL EXPORTED VALUES instead of regexing source.

// Keep in step with lib/analytics/reset.ts RESET_TABLES / TS_COLUMN — asserted
// by value in lib/analytics/reset.test.ts.
export const RESET_TABLES = ["impression", "reaction", "bookmark", "trainer_website_click"];
export const TS_COLUMN = {
  impression: "seen_at",
  reaction: "created_at",
  bookmark: "created_at",
  trainer_website_click: "clicked_at",
};

export function parseArgs(argv) {
  const confirm = argv.includes("--confirm");
  const refArg = argv.find((a) => a.startsWith("--project-ref="));
  const projectRef = refArg ? refArg.slice("--project-ref=".length) : null;
  return { confirm, projectRef };
}

export function deriveProjectRef(url) {
  const host = new URL(url).hostname;
  if (host === "localhost" || host === "127.0.0.1") return "local";
  const m = /^([^.]+)\.supabase\.co$/.exec(host);
  return m ? m[1] : host;
}

function banner(out, url, ref) {
  out("=== StablePass analytics reset ===");
  // The target is printed on EVERY run, dry or confirmed. Without it a
  // destructive run never tells the operator which database it just hit.
  out(`Target: ${new URL(url).host}  (project ref: ${ref})`);
  out(`Tables cleared: ${RESET_TABLES.join(", ")}`);
  out("Not touched: app_user, subscription, horse, trainer, follow — and no post ROW is deleted.");
  // This is the one sentence in a destructive script that has to be true.
  // Deleting `reaction` rows fires the BE's `reaction_like_count` trigger
  // (after insert or delete, per row), which decrements `post.like_count`. So
  // this reset DOES write post.like_count, driving it to 0. That is the
  // intended outcome — launch starts from zero — but it is a write outside the
  // four tables and must be stated, not discovered.
  out("Side effect: clearing `reaction` drives post.like_count to 0 via the reaction_like_count trigger (intended).");
  out("");
}

async function countRows(sb, table) {
  // Counted on the TIMESTAMP COLUMN the delete will actually filter on, not on
  // `*`. Counting `*` proves only that the table exists; if a timestamp column
  // were wrong or missing, the first three tables would already be deleted
  // before the fourth failed, leaving a half-cleared database. This makes the
  // pre-flight validate the real predicate column for every table up front.
  const { count, error } = await sb.from(table).select(TS_COLUMN[table], { count: "exact", head: true });
  if (error) {
    throw new Error(`could not count "${table}" on its delete column "${TS_COLUMN[table]}": ${error.message}`);
  }
  return count ?? 0;
}

/**
 * Run the reset. Returns the process EXIT CODE instead of calling
 * `process.exit`, so a test can drive it end to end.
 *
 * @param argv       process.argv.slice(2)
 * @param env        process.env
 * @param makeClient (url, serviceKey) => supabase-like client
 * @param out/err    line sinks (console.log / console.error in the CLI)
 */
export async function runResetCli({ argv, env, makeClient, out, err }) {
  const { confirm, projectRef } = parseArgs(argv);

  const url = env.SUPABASE_URL;
  const serviceKey = env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url) {
    err("Missing SUPABASE_URL in the environment.");
    return 1;
  }
  if (!serviceKey) {
    err("Missing SUPABASE_SERVICE_ROLE_KEY in the environment.");
    return 1;
  }

  // GATE A — TYPE-TO-CONFIRM PROJECT GUARD. This proves the operator can name
  // the project they are about to wipe; it does NOT independently verify that
  // SUPABASE_URL is the project they meant.
  //
  // NOTE THE ORDER: this runs BEFORE `makeClient`. A run aimed at the wrong
  // project must not even open a connection to it, and the test asserts that
  // no client was ever constructed on a refusal — which is why the factory is
  // injected rather than imported.
  const derivedRef = deriveProjectRef(url);
  if (!projectRef || projectRef !== derivedRef) {
    err("Refusing to run: --project-ref must be passed and must match the project SUPABASE_URL points at.");
    err(`  --project-ref given: ${projectRef ?? "(none)"}`);
    // Neither the derived ref NOR the host is printed. Both hand over the
    // answer (the ref is just the host's first label), which would turn a
    // type-to-confirm into a copy-paste prompt. The ref is not a secret — it
    // sits in the operator's own env — so the point is not concealment; it is
    // forcing a deliberate look at an independent source instead of a reflex
    // paste from an error message.
    err(
      "  It does not match the project SUPABASE_URL points at. Check which project you are aimed at\n" +
        "  (`echo $SUPABASE_URL`) and take the ref you intend from the Supabase dashboard or the runbook.",
    );
    return 1;
  }

  banner(out, url, derivedRef);

  const sb = makeClient(url, serviceKey);

  const plan = [];
  for (const table of RESET_TABLES) plan.push({ table, rows: await countRows(sb, table) });

  const total = plan.reduce((sum, p) => sum + p.rows, 0);
  for (const p of plan) out(`  ${p.table.padEnd(24)} ${p.rows}`);
  out(`  ${"total".padEnd(24)} ${total}`);
  out("");

  // GATE B — DRY RUN IS THE DEFAULT. Everything above this line is read-only
  // (`head: true` counts); the first mutation in the whole flow is below it.
  if (!confirm) {
    out("Dry run — no rows deleted.");
    out(`Re-run with --confirm --project-ref=${projectRef} to delete these rows for real.`);
    return 0;
  }

  for (const table of RESET_TABLES) {
    // PostgREST refuses an unqualified DELETE, so a filter is required; `gte`
    // on the row's own timestamp column matches every row (all four columns are
    // `timestamptz not null default now()` in the BE schema, so none can escape).
    const { error } = await sb.from(table).delete().gte(TS_COLUMN[table], "1970-01-01T00:00:00Z");
    // THROW rather than return here, so the wrapper's partial-delete warning
    // fires. A mid-loop failure is the single most likely way to end up
    // half-cleared, which is exactly when that warning matters most.
    if (error) throw new Error(`could not delete rows from "${table}": ${error.message}`);
  }

  // Report what was OBSERVED, not what was planned. Re-counting is the only
  // thing that distinguishes "deleted" from "attempted to delete".
  out("Deleted (before -> after):");
  let remaining = 0;
  for (const p of plan) {
    const after = await countRows(sb, p.table);
    remaining += after;
    out(`  ${p.table.padEnd(24)} ${p.rows} -> ${after}${after === 0 ? "" : "   ** NOT EMPTY **"}`);
  }

  if (remaining !== 0) {
    err(`\n${remaining} row(s) survived the reset. Investigate before launch.`);
    return 1;
  }
  out("\nAll engagement/analytics rows cleared.");
  return 0;
}
