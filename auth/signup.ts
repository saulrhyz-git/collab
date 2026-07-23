/**
 * Signup service — creates the user row and their default PERSONAL
 * workspace atomically. There's no session to derive app.current_user_id
 * from yet (the account doesn't exist until partway through this
 * function), so this manages its own transaction and sets the RLS session
 * GUC manually right after the user row is created — everything after
 * that point (the workspace + membership + activity log inserts) runs
 * with a real `current_app_user_id()`, satisfying the `workspaces_insert`
 * / `workspace_members_insert` policies' `owner_id = current_app_user_id()`
 * bootstrap checks (see db/rls-policies.sql). `users` itself has no RLS
 * policies at all — email lookup has to work before any session exists.
 *
 * The workspace id is generated here (not left to Postgres's column
 * default) and the insert is deliberately NOT `.returning()`'d. Postgres
 * re-checks a table's SELECT policy against the row an INSERT/UPDATE
 * returns — and `workspaces_select` requires `is_workspace_member(id)`,
 * which is false at this exact instant (the membership row that would
 * satisfy it doesn't exist until the very next statement). Asking for
 * `.returning()` here would fail with "new row violates row-level security
 * policy for table workspaces" for every ordinary signup. Once the
 * membership row is inserted, a plain SELECT on that same workspace id
 * passes the policy fine, so that's how the caller gets the full row back.
 */

// bcryptjs's CJS bundle doesn't expose statically-analyzable named exports
// (module.exports = require("./dist/bcrypt.js"), a dynamic re-export), so
// `import { hash } from "bcryptjs"` fails at runtime under Node ESM the
// same way `pg`'s `Pool` does — see db/client.ts for the longer version.
import bcryptjs from "bcryptjs";
const { hash } = bcryptjs;
import { randomUUID } from "node:crypto";
import { db } from "../db/client";
import { users, workspaces, workspaceMembers } from "../db/schema";
import { sql } from "drizzle-orm";

export interface SignupInput {
  email: string;
  password: string;
  fullName: string;
}

export interface SignupResult {
  userId: string;
  personalWorkspaceId: string;
}

export class EmailAlreadyRegisteredError extends Error {
  constructor() {
    super("An account with this email already exists.");
    this.name = "EmailAlreadyRegisteredError";
  }
}

export async function signupUser(input: SignupInput): Promise<SignupResult> {
  const normalizedEmail = input.email.trim().toLowerCase();

  const existing = await db.query.users.findFirst({
    where: (u, { eq }) => eq(u.email, normalizedEmail),
  });
  if (existing) throw new EmailAlreadyRegisteredError();

  const passwordHash = await hash(input.password, 12);

  return db.transaction(async (tx) => {
    const [user] = await tx
      .insert(users)
      .values({
        email: normalizedEmail,
        passwordHash,
        fullName: input.fullName.trim(),
      })
      .returning();

    // From here on, every insert in this transaction needs
    // current_app_user_id() to resolve to the account we just created.
    await tx.execute(sql`SELECT set_config('app.current_user_id', ${user.id}, true)`);

    const workspaceId = randomUUID();
    await tx.insert(workspaces).values({
      id: workspaceId,
      name: `${input.fullName.trim()}'s Workspace`,
      type: "PERSONAL",
      ownerId: user.id,
      slug: await generateUniqueSlug(tx, input.fullName),
    });

    await tx.insert(workspaceMembers).values({
      workspaceId,
      userId: user.id,
      role: "OWNER",
    });

    await tx.execute(sql`
      INSERT INTO activity_logs (workspace_id, user_id, action, metadata)
      VALUES (${workspaceId}, ${user.id}, 'workspace.created', '{"reason": "signup_default"}'::jsonb)
    `);

    return { userId: user.id, personalWorkspaceId: workspaceId };
  });
}

async function generateUniqueSlug(tx: any, fullName: string): Promise<string> {
  const base = fullName.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 40);
  let candidate = `${base}-${Math.random().toString(36).slice(2, 8)}`;
  // Extremely low collision odds given the random suffix; single check is sufficient.
  const clash = await tx.query.workspaces.findFirst({
    where: (w: any, { eq }: any) => eq(w.slug, candidate),
  });
  if (clash) candidate = `${base}-${Math.random().toString(36).slice(2, 10)}`;
  return candidate;
}
