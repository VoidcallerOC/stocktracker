// Runs the SQL constraint tests against a THROWAWAY Postgres database.
// Usage: TEST_DATABASE_URL=postgres://... npm run test:db
// Refuses hosted databases so it can never touch a real project by accident.
import { execFileSync } from "node:child_process";

const url = process.env.TEST_DATABASE_URL;
if (!url) {
  console.error("TEST_DATABASE_URL is not set; skipping (needs a disposable local Postgres 15+).");
  process.exit(1);
}
const host = (() => {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
})();
if (!["localhost", "127.0.0.1", "::1", ""].includes(host) || /supabase|neon|render|vercel/i.test(url)) {
  console.error("Refusing to run destructive DB tests against a non-local database.");
  process.exit(1);
}
// The SQL files create schemas from scratch. Reset the disposable database first so a
// local rerun does not collide with the previous migration. Remote URLs are refused above.
execFileSync(
  "psql",
  [url, "-v", "ON_ERROR_STOP=1", "-q", "-c",
    "DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public; DROP SCHEMA IF EXISTS auth CASCADE;"],
  { stdio: "inherit" },
);
execFileSync(
  "psql",
  [url, "-v", "ON_ERROR_STOP=1", "-q",
    "-f", "test/db/00_supabase_stub.sql",
    "-f", "db/migrations/0001_init.sql",
    "-f", "db/migrations/0002_public_read_and_retention.sql",
    "-f", "test/db/constraints.test.sql"],
  { stdio: "inherit" },
);
