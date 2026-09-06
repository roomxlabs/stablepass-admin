#!/usr/bin/env node
// Launch reset CLI (ENG-984). Run DELIBERATELY, BY A HUMAN, before go-live —
// this is NEVER wired into deploy, CI or a migration. It wipes accumulated
// analytics/engagement rows so Mel and Justin's weeks of testing don't
// pollute day-one numbers.
//
// THIS FILE IS DELIBERATELY A SHELL. All of the logic — including both safety
// gates (the --project-ref type-to-confirm guard and the dry-run default) —
// lives in ./reset-analytics.core.mjs, which is imported and behaviourally
// tested by lib/analytics/reset.test.ts. That split exists because review of
// ENG-984 showed both gates could be DELETED with a fully green suite while
// they sat inside an unimportable `main()`: the only test covering them
// matched strings in this file's source. Everything here is now effect
// wiring, so there is nothing left in this file that a test cannot reach.
//
// Usage:
//   node scripts/reset-analytics.mjs --project-ref=<ref>              (dry run)
//   node scripts/reset-analytics.mjs --confirm --project-ref=<ref>    (for real)
import { createClient } from "@supabase/supabase-js";
import { runResetCli } from "./reset-analytics.core.mjs";

// A destructive script must never fail as a raw unhandled rejection: the stack
// trace alone would leave the operator unsure whether anything was deleted.
// Exit non-zero with a plain message instead.
runResetCli({
  argv: process.argv.slice(2),
  env: process.env,
  makeClient: (url, serviceKey) => createClient(url, serviceKey, { auth: { persistSession: false } }),
  out: (line) => console.log(line),
  err: (line) => console.error(line),
})
  .then((code) => process.exit(code))
  .catch((e) => {
    console.error(`Reset aborted: ${e instanceof Error ? e.message : String(e)}`);
    console.error(
      "If this happened after the counts were printed, some tables may already have been cleared — re-run the dry run to see the current state.",
    );
    process.exit(1);
  });
