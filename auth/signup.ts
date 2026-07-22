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
 */

import { hash } from "bcryptjs";
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

    const [personalWorkspace] = await tx
      .insert(workspaces)
      .values({
        name: `${input.fullName.trim()}'s Workspace`,
        type: "PERSONAL",
        ownerId: user.id,
        slug: await generateUniqueSlug(tx, input.fullName),
      })
      .returning();

    await tx.insert(workspaceMembers).values({
      workspaceId: personalWorkspace.id,
      userId: user.id,
      role: "OWNER",
    });

    await tx.execute(sql`
      INSERT INTO activity_logs (workspace_id, user_id, action, metadata)
      VALUES (${personalWorkspace.id}, ${user.id}, 'workspace.created', '{"reason": "signup_default"}'::jsonb)
    `);

    return { userId: user.id, personalWorkspaceId: personalWorkspace.id };
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
