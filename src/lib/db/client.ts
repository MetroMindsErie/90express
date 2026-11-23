import postgres from "postgres";

/**
 * Single Postgres client, reused across hot reloads in development.
 *
 * Plain SQL on purpose. The schema in db/migrations runs unchanged on local
 * Postgres and on Supabase, so moving the hosted database later is a
 * connection-string change rather than a rewrite.
 */
const connectionString =
  process.env.DATABASE_URL ??
  "postgres://localhost:5432/ninety_express";

declare global {
  var __ninetyExpressSql: ReturnType<typeof postgres> | undefined;
}

export const sql =
  globalThis.__ninetyExpressSql ??
  postgres(connectionString, {
    max: 10,
    idle_timeout: 20,
    // Postgres numeric/int8 come back as strings by default; the queries in
    // src/lib/db/queries.ts cast money to int, so parse those to numbers.
    types: {
      numeric: {
        to: 1700,
        from: [1700],
        serialize: (x: number) => String(x),
        parse: (x: string) => Number(x),
      },
    },
  });

if (process.env.NODE_ENV !== "production") {
  globalThis.__ninetyExpressSql = sql;
}
