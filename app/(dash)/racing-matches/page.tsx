import { requireAdminPage } from "@/lib/auth/admin";
import { getPendingProposals } from "./data";
import MatchQueue from "./MatchQueue";
import "./racing-matches.css";

// Racing match queue (RF4 / ENG-296) — the one-time human gate of the feed.
//
// Re-asserts requireAdminPage() rather than leaning on the (dash) layout:
// Next renders layout and page in parallel and caches the layout across soft
// navigations, so the shell gate does not cover this page's own read
// (see .rx/gotchas.md).
export const dynamic = "force-dynamic";

export default async function RacingMatchesPage() {
  const { sb } = await requireAdminPage();
  const proposals = await getPendingProposals(sb);

  return (
    <>
      <div className="admin-topbar">
        <h1>Racing matches</h1>
        <div className="actions">
          <span className="rm-pill green">{proposals.length} pending</span>
        </div>
      </div>

      <div className="admin-content">
        <p className="rm-note">
          The racing feed proposes a match when a runner looks like one of your horses. Check the
          breeding and trainer line up, then confirm — a confirmed match links the horse to the feed
          for good, and its races start appearing automatically.
        </p>
        <MatchQueue initial={proposals} />
      </div>
    </>
  );
}
