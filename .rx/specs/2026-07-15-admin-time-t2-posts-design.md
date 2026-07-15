# Time display — T2 posts library (ENG-252)
Epic ENG-250 · Base `feature/time-display-v1` · Blocked by ENG-251 · Full spec in Linear.
Surface: `app/(dash)/posts/{format.ts,types.ts,PostRow.tsx,PostsLibrary.test.tsx}`.
PostView carries raw status+published_at+scheduled_for (ISO) instead of preformatted whenLabel;
PostRow renders <LocalTime kind="when">. Visual output identical, browser TZ. Test: fixed instant
renders offset wall-clock under forced TZs.
