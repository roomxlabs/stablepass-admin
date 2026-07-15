# Time display — T4 compose scheduling UX (ENG-254)
Epic ENG-250 · Base `feature/time-display-v1` · Blocked by ENG-251; PR #10 merged first · Full spec in Linear.
Surface: `app/(dash)/compose/**`.
Create flow: Date (type=date) + Time (type=time, minute step) labelled pair replaces datetime-local;
both required; combined client-side → UTC ISO → existing POST /schedule. Edit mode (draft|scheduled):
current schedule via <LocalTime kind="when">, prefilled pair (scheduled_for → local), Schedule/Update
action (PATCH fields first, then POST /schedule); published/unpublished get no scheduling UI. Inline
errors: scheduled_for_in_past / validation_failed / invalid_status (409 from cron race).
