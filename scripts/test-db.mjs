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
execFileSync(
  "psql",
  [url, "-v", "ON_ERROR_STOP=1", "-q",
    "-f", "test/db/00_supabase_stub.sql",
    "-f", "db/migrations/0001_init.sql",
    "-f", "test/db/constraints.test.sql"],
  { stdio: "inherit" },
);
