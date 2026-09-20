/* eslint-disable @typescript-eslint/no-explicit-any */
// Test-support only. Wraps a scriptable Supabase stand-in so a test can assert
// what the code SENT, not merely that no `error` came back.
//
// `lib/testing/supabase-fake.ts`'s builder returns itself from every method and
// discards the arguments, which makes `.eq("id", mine)` and
// `.eq("id", "someone-else")` indistinguishable, and makes a wrong insert
// invisible. This proxy records the projection strings, the mutation payloads
// and the filters as they go past, then delegates to the underlying fake.
//
// Filters are kept in a SEPARATE array from the write trace so that
// `expect(rec.writes).toEqual([])` still means "no write happened".
//
// ENG-1267: `eq` was the only comparator recorded, so a READ guarded by
// `.is("retired_at", null)` (excluding retired rows from a picker) was
// unprovable — the fake applies no filtering itself, so nothing distinguished
// that call from an unfiltered read. Every other comparator the fake
// implements is now recorded too, alongside (not instead of) `eq`'s existing
// bare format.

export type WriteCall = { table: string; op: "insert" | "upsert" | "update" | "delete"; payload: unknown };

export type CallRecord = {
  /** Every projection string passed to `.select()`, as `table:projection`. */
  selects: string[];
  /** Every `.insert()` / `.update()` / `.delete()` with its payload. */
  writes: WriteCall[];
  /** Every equality filter, as `table.column=value`. */
  filters: string[];
};

export function blankRecord(): CallRecord {
  return { selects: [], writes: [], filters: [] };
}

// `upsert` is listed even though the current fake has no such method: the day
// it gains one, an unrecorded write would make every
// `expect(rec.writes).toEqual([])` silently vacuous.
const WRITE_OPS = new Set(["insert", "upsert", "update", "delete"]);

// Non-`eq` comparators (ENG-1267) — recorded in the SAME `rec.filters` array
// as `eq`, but with the comparator name in the string, since a bare
// `table.column=value` cannot tell `.is(col, null)` apart from `.eq(col, null)`.
const OTHER_COMPARATORS = new Set(["is", "neq", "in", "ilike", "gt", "gte", "lt", "lte"]);

export function recordCalls<T extends { from: (table: string) => any }>(client: T, rec: CallRecord): T {
  return {
    ...client,
    from(table: string) {
      const builder = client.from(table);
      const wrapped: any = new Proxy(builder, {
        get(target, prop, receiver) {
          const value = Reflect.get(target, prop, receiver);
          if (typeof value !== "function") return value;
          return (...args: any[]) => {
            const name = String(prop);
            if (name === "select" && typeof args[0] === "string") {
              rec.selects.push(`${table}:${args[0]}`);
            } else if (WRITE_OPS.has(name)) {
              rec.writes.push({ table, op: name as WriteCall["op"], payload: args[0] });
            } else if (name === "eq") {
              rec.filters.push(`${table}.${args[0]}=${args[1]}`);
            } else if (OTHER_COMPARATORS.has(name)) {
              rec.filters.push(`${table}.${args[0]} ${name} ${JSON.stringify(args[1])}`);
            }
            const out = value.apply(target, args);
            // Keep the recorder attached across the whole chain.
            return out === target ? wrapped : out;
          };
        },
      });
      return wrapped;
    },
  } as T;
}

/** The projection a table was read with, or undefined if it was never read. */
export function selectFor(rec: CallRecord, table: string): string | undefined {
  const hit = rec.selects.find((s) => s.startsWith(`${table}:`));
  return hit?.slice(table.length + 1);
}
