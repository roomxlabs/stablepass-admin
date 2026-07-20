"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Icon, type IconName } from "./icons";

type NavItem = { href: string; label: string; icon: IconName };

// Nav matches screens/02-dashboard.html. Counts in the mockup are seeded demo
// numbers; the real badges are wired when each resource screen ships, so the
// shell renders none rather than fake ones.
const PRIMARY: NavItem[] = [
  { href: "/", label: "Dashboard", icon: "home" },
  { href: "/analytics", label: "Analytics", icon: "search" },
  { href: "/compose", label: "Compose", icon: "play" },
  { href: "/posts", label: "Posts", icon: "bookmark" },
];

const LIBRARY: NavItem[] = [
  { href: "/horses", label: "Horses", icon: "horseHead" },
  { href: "/trainers", label: "Trainers", icon: "user" },
];

function isActive(pathname: string, href: string): boolean {
  return href === "/" ? pathname === "/" : pathname === href || pathname.startsWith(`${href}/`);
}

function NavList({ items, pathname }: { items: NavItem[]; pathname: string }) {
  return (
    <ul className="admin-nav">
      {items.map((item) => (
        <li key={item.href}>
          <Link href={item.href} className={isActive(pathname, item.href) ? "active" : undefined}>
            <Icon name={item.icon} /> {item.label}
          </Link>
        </li>
      ))}
    </ul>
  );
}

export default function AdminNav() {
  const pathname = usePathname();
  return (
    <>
      <NavList items={PRIMARY} pathname={pathname} />
      <div className="admin-sidebar-section">Library</div>
      <NavList items={LIBRARY} pathname={pathname} />
    </>
  );
}
