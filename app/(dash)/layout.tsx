import { requireAdminPage } from "@/lib/auth/admin";
import { signOut } from "@/app/signin/actions";
import AdminNav from "./AdminNav";
import { Icon } from "./icons";

// Shell + gate for every dashboard page. requireAdminPage() runs first, so a
// non-admin never reaches any (dash) child: no session -> /signin, non-admin
// -> /signin?error=forbidden. Renders the left nav; children own their topbar.
export default async function DashLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  const { user } = await requireAdminPage();
  const email = user.email ?? "admin@stablepass.co";
  const initial = (email.trim()[0] ?? "A").toUpperCase();

  return (
    <div className="admin-shell">
      <aside className="admin-sidebar">
        <div className="admin-sidebar-logo">
          {/* eslint-disable-next-line @next/next/no-img-element -- fixed-height brand lockup, CSS-scaled */}
          <img src="/brand/wordmark-white.png" alt="stablepass." />
          <span className="badge">Admin</span>
        </div>

        <AdminNav />

        <form action={signOut} className="admin-sidebar-foot">
          <div className="av">{initial}</div>
          <div className="who">
            <strong>{email}</strong>
            <span>Staff · Admin</span>
          </div>
          <button type="submit" className="signout-btn" aria-label="Sign out" title="Sign out">
            <Icon name="logOut" />
          </button>
        </form>
      </aside>

      <main className="admin-main">{children}</main>
    </div>
  );
}
