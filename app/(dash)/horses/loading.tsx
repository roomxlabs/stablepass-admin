import { SkeletonScreen, SkeletonGrid } from "../skeletons";

// Horses skeleton. Horses is a photo CARD GRID, not a table (see
// `.horse-grid-adm` in horses.css), so it gets tiles — a table skeleton here
// would resolve into a completely different layout and make the load feel
// like a jump rather than a fill-in.
export default function HorsesLoading() {
  return (
    <SkeletonScreen title="Horses" label="Loading horses">
      <SkeletonGrid tiles={8} />
    </SkeletonScreen>
  );
}
