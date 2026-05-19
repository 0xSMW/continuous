import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";

import { env } from "../env";
import * as schema from "./schema";

const globalForDb = globalThis as typeof globalThis & {
  continuousPool?: pg.Pool;
};

export const pool =
  globalForDb.continuousPool ??
  new pg.Pool({
    connectionString: env.DATABASE_URL,
    max: 10,
  });

if (process.env.NODE_ENV !== "production") {
  globalForDb.continuousPool = pool;
}

export const db = drizzle(pool, { schema });
