import { requireAdminPage } from "@/lib/auth/admin";
import { signOut } from "@/app/signin/actions";
import AdminNav, { AdminMobileNav } from "./AdminNav";
import { Icon } from "./icons";

// Shell + gate for every dashboard page. requireAdminPage() runs first, so a
// non-admin never reaches any (dash) child: no session -> /signin, non-admin
// -> /signin?error=forbidden. Renders the left nav; children own their topbar.
//
// Below the 900px shell breakpoint the sidebar is hidden by CSS and
// <AdminMobileNav> supplies the brand bar + hamburger + slide-in drawer. It
// sits inside <main> above the child's own topbar; at desktop widths every one
// of its elements is display:none, so the desktop shell is unchanged.
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

      <main className="admin-main">
        <AdminMobileNav email={email} initial={initial} signOutAction={signOut} />
        {children}
      </main>
    </div>
  );
}
