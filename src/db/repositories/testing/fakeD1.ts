// Recording fake D1. Vitest runs in plain Node with no D1 binding, so repository
// tests assert on the SQL and bindings Drizzle emits — that is the only way to
// prove the shop-scoping guarantee without a real database.
//
// Mirrors the surface the Drizzle d1 driver actually uses:
//   client.prepare(sql) -> stmt.bind(...params) -> .all() / .run() / .raw()

/**
 * Drizzle asks D1 for positional rows (`raw()`) and maps them onto the columns it
 * selected, so the fake has to hand values back in the order the SQL names them.
 * Reads that order out of the `select ... from` or `... returning ...` clause.
 */
function selectedColumns(sql: string): string[] | null {
  const clause = /\breturning (.+)$/i.exec(sql)?.[1] ?? /^select (.+?) from /i.exec(sql)?.[1];
  if (!clause) return null;
  return clause.split(',').map((part) => {
    const identifiers = [...part.matchAll(/"([^"]+)"/g)].map((match) => match[1]);
    return identifiers[identifiers.length - 1] ?? part.trim();
  });
}

export interface RecordedQuery {
  sql: string;
  params: unknown[];
}

export interface FakeD1 {
  db: D1Database;
  queries: RecordedQuery[];
  /** The most recent query. Throws if nothing ran — a silent undefined here would hide a broken test. */
  lastQuery(): RecordedQuery;
}

/**
 * @param rowsFor returns the rows a given query should resolve to. Defaults to none.
 */
export function createFakeD1(
  rowsFor: (query: RecordedQuery) => Record<string, unknown>[] = () => [],
): FakeD1 {
  const queries: RecordedQuery[] = [];

  const client = {
    prepare(sql: string) {
      return {
        bind(...params: unknown[]) {
          const query: RecordedQuery = { sql, params };
          queries.push(query);
          const results = rowsFor(query);
          return {
            all: async () => ({ results, success: true, meta: { changes: results.length } }),
            run: async () => ({ results, success: true, meta: { changes: results.length } }),
            raw: async () => {
              const columns = selectedColumns(sql);
              if (!columns) return results.map((row) => Object.values(row));
              return results.map((row) => columns.map((column) => row[column] ?? null));
            },
            first: async () => results[0] ?? null,
          };
        },
      };
    },
    batch: async () => [],
  };

  return {
    db: client as unknown as D1Database,
    queries,
    lastQuery() {
      const query = queries[queries.length - 1];
      if (!query) throw new Error('No query was executed');
      return query;
    },
  };
}
