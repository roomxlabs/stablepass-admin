import { Icon } from "./icons";

// Placeholder dashboard landing. This file is owned by ENG-174 (T4), which
// replaces this body with the real tiles + race-day queue + quiet horses.
// T3 (ENG-173) ships only the auth shell + gate, and needs a page inside the
// (dash) group so the shell is reachable/testable at "/".
export default function DashboardPage() {
  return (
    <>
      <div className="admin-topbar">
        <h1>Dashboard</h1>
        <div className="actions">
          <div className="search">
            <Icon name="search" /> Search posts, horses, trainers…
          </div>
        </div>
      </div>
      <div className="admin-content">
        <div className="dash-placeholder">
          <h2>Dashboard shell ready</h2>
          <p>Tiles, race-day queue and quiet horses arrive in T4 (ENG-174).</p>
        </div>
      </div>
    </>
  );
}
