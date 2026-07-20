// RFC4180 CSV helper for admin analytics CSV exports (ENG-275).

function escapeCell(cell: string | number | null | undefined): string {
  if (cell == null) return "";
  let s = String(cell);
  // CSV/formula-injection guard: Excel/Sheets evaluate a leading =, +, -, @,
  // tab or CR as a formula even when the cell is quoted — quoting alone is
  // NOT a mitigation. Prefix with an apostrophe to force text interpretation.
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  if (/[",\r\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

export function toCsv(headers: string[], rows: (string | number | null | undefined)[][]): string {
  const lines = [headers.map(escapeCell).join(",")];
  for (const row of rows) lines.push(row.map(escapeCell).join(","));
  return lines.join("\r\n") + "\r\n";
}

export function trialsCsvFilename(d: Date = new Date()): string {
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  return `stablepass-trials-${yyyy}-${mm}-${dd}.csv`;
}
