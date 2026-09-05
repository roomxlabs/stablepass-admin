import { SkeletonScreen, SkeletonStats, SkeletonTable } from "./skeletons";

// The (dash) group fallback: the dashboard itself, AND every route without a
// `loading.tsx` of its own (compose, waitlist, the new/edit forms), because a
// segment's loading.tsx covers its whole subtree.
//
// Which is why the heading is NOT "Dashboard". A route-specific skeleton can
// show its real title so the heading does not flicker; this one cannot — it
// stands in for a form as often as for the dashboard, and titling an "Add
// horse" page "Dashboard" for a beat is worse than saying nothing specific.
// The shape stays dashboard-ish (tiles + a table) because that is the widest
// of the pages it covers; the routes that most need a truer shape have their
// own file.
//
// Before ENG-964 not one of the 11 dash routes had a loading.tsx, so every
// server page was a cold blocking render — the posts page does ~5 round-trips
// plus media signing before it paints anything, and the operator stared at the
// previous screen the whole time with no signal the click had registered.
export default function DashboardLoading() {
  return (
    <SkeletonScreen title="Loading…" label="Loading">
      <SkeletonStats count={4} />
      <div style={{ height: 24 }} />
      <SkeletonTable columns={5} rows={6} />
    </SkeletonScreen>
  );
}
