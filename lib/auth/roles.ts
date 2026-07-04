// Two roles only. Admin = an app_user row with is_admin=true (no separate identity).
export type Role = "subscriber" | "admin";
export const isAdmin = (u: { is_admin?: boolean } | null) => !!u?.is_admin;
