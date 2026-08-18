# ENG-616 — before/after screenshots

Evidence for stablepass-admin PR #39 (H2: sex becomes Male/Female plus a Gelded checkbox).
Both sets were captured by the same Playwright harness on the same machine on 18 Aug 2026, so
they are directly comparable; only the code differs.

| file | before | after |
| --- | --- | --- |
| `07-add-horse.png` | Sex is a five-item select preselected to **Gelding** | `Select a sex` (nothing chosen) + a Gelded checkbox, disabled until Male |
| `08-edit-horse.png` | Mahogany shows `Gelding` | Mahogany shows **Male** + **Gelded** checked |
| `05-horses-list.png` | meta from the TypeScript formula | meta from `horse_age` / `horse_description` |

On the list, note Anamoe: `5yo colt` before, `5yo horse` after. That is the bug being fixed —
the description is now derived from age instead of frozen at data entry. Winx still reads
`by Chris Waller · retired` (age dropped), and Barrier Trial, which has no foaling year and no
sex on record, reads `by James Cummings` with nothing invented.
