/**
 * Seeds (or promotes) a local super-admin account for development.
 *
 * Credentials are read from environment variables, not hardcoded, so
 * nothing sensitive ever ends up in a tracked file — set them in your
 * gitignored .env (see .env.example for the placeholder names). This
 * script is meant for local/dev use; the password strength requirement
 * the signup API route enforces (8+ characters) is deliberately NOT
 * re-checked here since it calls the service function directly, but you
 * should still use something real if this database is reachable from
 * anywhere but your own machine.
 *
 * Usage: npm run db:seed
 */

import "dotenv/config";
import { eq } from "drizzle-orm";
import { db } from "../db/client";
import { users } from "../db/schema";
import { signupUser, EmailAlreadyRegisteredError } from "../auth/signup";

async function main() {
  const email = (process.env.SEED_SUPERADMIN_EMAIL ?? "").trim().toLowerCase();
  const password = process.env.SEED_SUPERADMIN_PASSWORD ?? "";
  const fullName = process.env.SEED_SUPERADMIN_NAME?.trim() || "Super Admin";

  if (!email || !password) {
    console.error(
      "Set SEED_SUPERADMIN_EMAIL and SEED_SUPERADMIN_PASSWORD in your .env before running this script."
    );
    process.exit(1);
  }

  let userId: string;

  try {
    const result = await signupUser({ email, password, fullName });
    userId = result.userId;
    console.log(`Created new user ${email} (personal workspace ${result.personalWorkspaceId}).`);
  } catch (err) {
    if (err instanceof EmailAlreadyRegisteredError) {
      const existing = await db.query.users.findFirst({ where: eq(users.email, email) });
      if (!existing) throw err;
      userId = existing.id;
      console.log(`User ${email} already exists — promoting to super admin (password left unchanged).`);
    } else {
      throw err;
    }
  }

  await db.update(users).set({ isSuperAdmin: true }).where(eq(users.id, userId));
  console.log(`${email} is now a super admin — can read/write every workspace and project.`);
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
