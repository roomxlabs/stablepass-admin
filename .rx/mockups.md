# stablepass-admin — Design source (mockups)

Admin dashboard screens build against `../docs/dev-handover/mockups/web/admin/`.
Design system: `mockups/web/style.css` (shared with member web).

> **The path above is STALE.** The screens really live at
> `<repo>/../dev-handover/StablePass-mockups/mockups/web/admin/screens/`, and the design
> system at `.../mockups/web/style.css`. Resolve with `find … -name '<NN>-*.html'`.

| Screen | Mockup file |
|---|---|
| Sign in — **step 1 of 2**: email + password (`is_admin` gate) | `web/admin/screens/01-signin.html` **(superseded — see below)** |
| Two-factor challenge — **step 2 of 2**: 6-digit TOTP code | *no mockup* — built in ENG-370 by reusing `01-signin.html`'s `.admin-signin-card` shell |
| Forced TOTP enrolment (`/signin/mfa-setup`) | *no mockup* — ENG-371 (A2) |
| Dashboard — content queue & race day | `web/admin/screens/02-dashboard.html` |
| Compose post | `web/admin/screens/03-compose.html` |
| Posts library (filters + search + discard draft) | `web/admin/screens/04-posts.html` |
| Horses DB | `web/admin/screens/05-horses.html` |
| Add horse | `web/admin/screens/07-add-horse.html` |
| Trainers DB | `web/admin/screens/06-trainers.html` |
| Add trainer | `web/admin/screens/08-add-trainer.html` |
| Analytics (period toggle, opens/trials/engagement) | `web/admin/screens/09-analytics.html` |
| Per-post analytics | `web/admin/screens/10-post-analytics.html` |

Every FE ticket carries a confirmed mockup reference; flag any requirement with no backing mockup.

## `01-signin.html` is SUPERSEDED on 2FA (ENG-370), not stale

The mockup puts email, password **and** the Authenticator code on one form. That single-submit
shape is not buildable: Supabase must complete password auth and mint the AAL1 session **before**
a TOTP code can be verified at all, so a one-form version would have to hold the password
server-side. Shipped instead as **two steps, two screens**:

- `/signin` — email + password (the mockup's first two field groups), button reads **Continue**.
- `/signin/mfa` — the mockup's **Authenticator code** group, moved to its own card: same
  `.admin-signin` / `.admin-signin-card` shell, same lockup + ADMIN badge, same
  `.input-group`/`.input-label`/`.input` classes, same `letter-spacing: 0.3em` +
  `tabular-nums`, same "From your Authenticator app" helper, same
  "Protected by 2FA · Staff sessions audited." legal line.

The mockup's field styling remains the visual reference. Do **not** "fix" the app back to a
single form to match the mockup.
