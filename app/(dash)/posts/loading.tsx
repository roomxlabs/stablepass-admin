import { SkeletonScreen, SkeletonTable } from "../skeletons";

// Posts library skeleton. This is the route the ticket singles out: the server
// page runs ~5 round-trips (posts + horse/trainer name lookups + status counts)
// and then signs every Mux thumbnail before it paints, so it is the longest
// cold render in the dashboard and the one where a blank hold reads as a
// broken click. 6 status chips + the 7 columns PostsLibrary renders.
export default function PostsLoading() {
  return (
    <SkeletonScreen title="Posts" label="Loading the posts library">
      <SkeletonTable columns={6} rows={8} chips={5} thumbs />
    </SkeletonScreen>
  );
}
