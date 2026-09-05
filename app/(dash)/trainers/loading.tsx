import { SkeletonScreen, SkeletonTable } from "../skeletons";

// Trainers skeleton — filter chips + the trainers table (trainer, stable,
// horses, last post, status, actions).
export default function TrainersLoading() {
  return (
    <SkeletonScreen title="Trainers" label="Loading trainers">
      <SkeletonTable columns={5} rows={7} chips={3} thumbs />
    </SkeletonScreen>
  );
}
