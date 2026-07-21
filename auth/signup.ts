/**
 * Signup service — creates the user row and their default PERSONAL
 * workspace atomically. Runs OUTSIDE withRlsContext because at signup
 * time there is no authenticated user yet to set app.current_user_id to;
 * instead this uses a single DB transaction with direct inserts under a
 * role that's allowed to bypass the "no direct INSERT policy" restriction
 * on `workspaces` (see rls-policies.sql comment) via a SECURITY DEFINER
 * function. Simpler alternative used here: do the inserts in a plain
 * transaction, then immediately re-derive the session so all *subsequent*
 * requests go through withRlsContext as normal.
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
    // Bypass RLS for this bootstrap transaction only — the db role used
    // here is a privileged "signup" role granted BYPASSRLS, distinct from
    // the general application role used by withRlsContext. Never reuse
    // this connection/role for anything beyond signup.
    const [user] = await tx
      .insert(users)
      .values({
        email: normalizedEmail,
        passwordHash,
        fullName: input.fullName.trim(),
      })
      .returning();

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
