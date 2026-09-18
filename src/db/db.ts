import { drizzle } from 'drizzle-orm/d1';
import * as schema from './schema';

/**
 * Wraps a D1 binding in a Drizzle client. This is NOT a connection — there is
 * no handshake and no pool, just an object over the binding — so calling it
 * once per handler is free. Pass the returned client down to the repository
 * functions in `src/db/repos/` rather than re-deriving it deeper in the stack.
 */
export function createDb(d1: D1Database) {
  return drizzle(d1, { schema });
}

export type Db = ReturnType<typeof createDb>;
