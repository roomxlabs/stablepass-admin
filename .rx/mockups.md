# stablepass-admin — Design source (mockups)

Admin dashboard screens build against `../docs/dev-handover/mockups/web/admin/`.
Design system: `mockups/web/style.css` (shared with member web).

| Screen | Mockup file |
|---|---|
| Sign in (is_admin gate; no 2FA in v1) | `web/admin/screens/01-signin.html` |
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
