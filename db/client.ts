import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "./schema";

// The pool connects as an application role that owns no BYPASSRLS privilege.
// RLS policies use FORCE ROW LEVEL SECURITY, so even the table owner role
// (if misconfigured) would still be subject to policies — defense in depth.
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 10,
});

export const db = drizzle(pool, { schema });
