import { SkeletonScreen, SkeletonStats, SkeletonTable } from "../skeletons";

// Analytics skeleton. Five summary tiles (`.adm-stats five`) then the first of
// the four engagement tables — the screen is tall, and stubbing all four would
// push a wall of grey below the fold for no extra signal.
export default function AnalyticsLoading() {
  return (
    <SkeletonScreen title="Analytics" label="Loading analytics">
      <SkeletonStats count={5} />
      <div style={{ height: 24 }} />
      <SkeletonTable columns={4} rows={6} />
    </SkeletonScreen>
  );
}
