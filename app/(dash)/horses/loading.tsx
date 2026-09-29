import { SkeletonScreen, SkeletonGrid } from "../skeletons";

// Horses skeleton. Horses is a photo CARD GRID, not a table (see
// `.horse-grid-adm` in horses.css), so it gets tiles — a table skeleton here
// would resolve into a completely different layout and make the load feel
// like a jump rather than a fill-in. 12 tiles = two full rows of the 6-column
// grid (ENG-1583).
export default function HorsesLoading() {
  return (
    <SkeletonScreen title="Horses" label="Loading horses">
      <SkeletonGrid tiles={12} />
    </SkeletonScreen>
  );
}
