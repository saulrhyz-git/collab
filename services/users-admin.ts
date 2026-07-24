/**
 * Superadmin "add user" facility. Distinct from auth/signup.ts's self-serve
 * flow in two ways: (1) the superadmin sets the account's initial password
 * directly (typed into the create-user form and relayed to the person
 * out-of-band) rather than the user choosing their own at signup, so
 * mustResetPassword is set true as a signal the account is using a
 * superadmin-assigned password; (2) it accepts the contact/business fields
 * and the account-level Role choice the superadmin form collects.
 *
 * "Role" here is the account's platform-level role — ordinary user vs.
 * super admin (users.is_super_admin) — NOT a client/project custom role.
 * Under the new isolation model (db/rls-policies.sql PART 2), a freshly
 * created user has zero visibility into anyone else's clients/engagements
 * until explicitly invited, so there's nothing else to assign at creation
 * time; every other user still gets their own PERSONAL workspace (same as
 * self-serve signup) so they have somewhere to work.
 */

import bcryptjs from "bcryptjs";
const { hash } = bcryptjs;
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { db } from "../db/client";
import { users, workspaces, workspaceMembers } from "../db/schema";
import { isSuperAdmin } from "../auth/super-admin";

export class NotAuthorizedError extends Error {}
export class EmailAlreadyRegisteredError extends Error {
  constructor() {
    super("An account with this email already exists.");
    this.name = "EmailAlreadyRegisteredError";
  }
}
export class ValidationError extends Error {}

type AccountRole = "USER" | "SUPER_ADMIN";

export interface CreateUserBySuperAdminInput {
  actingUserId: string;
  fullName: string;
  contactNumber: string;
  email: string;
  role: AccountRole;
  temporaryPassword: string;
  businessName?: string;
  businessAddress?: string;
}

const MIN_PASSWORD_LENGTH = 8;

export async function createUserBySuperAdmin(input: CreateUserBySuperAdminInput) {
  if (!(await isSuperAdmin(input.actingUserId))) {
    throw new NotAuthorizedError("Only a super admin can add users.");
  }

  const fullName = input.fullName.trim();
  const contactNumber = input.contactNumber.trim();
  const normalizedEmail = input.email.trim().toLowerCase();

  if (!fullName) throw new ValidationError("Full name is required.");
  if (!contactNumber) throw new ValidationError("Contact number is required.");
  if (!normalizedEmail) throw new ValidationError("Email address is required.");
  if (input.role !== "USER" && input.role !== "SUPER_ADMIN") throw new ValidationError("Role must be USER or SUPER_ADMIN.");
  if (!input.temporaryPassword || input.temporaryPassword.length < MIN_PASSWORD_LENGTH) {
    throw new ValidationError(`Temporary password must be at least ${MIN_PASSWORD_LENGTH} characters.`);
  }

  const existing = await db.query.users.findFirst({ where: eq(users.email, normalizedEmail) });
  if (existing) throw new EmailAlreadyRegisteredError();

  const passwordHash = await hash(input.temporaryPassword, 12);

  return db.transaction(async (tx) => {
    const [user] = await tx
      .insert(users)
      .values({
        email: normalizedEmail,
        passwordHash,
        fullName,
        contactNumber,
        businessName: input.businessName?.trim() || undefined,
        businessAddress: input.businessAddress?.trim() || undefined,
        isSuperAdmin: input.role === "SUPER_ADMIN",
        mustResetPassword: true,
      })
      .returning();

    // Unlike auth/signup.ts (a pre-auth flow with no session yet, which has
    // to bootstrap app.current_user_id to the brand-new account manually so
    // its own workspace/membership inserts pass RLS), this runs inside the
    // ACTING SUPERADMIN's already-authenticated request. Deliberately NOT
    // re-pointing app.current_user_id at the new user here — this call runs
    // as a nested db.transaction() (a SAVEPOINT on the same connection, per
    // db/client.ts), and set_config(..., true)'s LOCAL scoping is tied to
    // the whole outer transaction, not the savepoint — reassigning it would
    // leak the new user's identity into the rest of this request after this
    // function returns. It isn't needed anyway: is_workspace_admin() and
    // workspaces_insert's WITH CHECK both have an `is_super_admin()`
    // shortcut baked in, and the acting caller IS one (asserted above), so
    // both inserts below pass regardless of whose id current_app_user_id()
    // currently resolves to.
    const workspaceId = randomUUID();
    await tx.insert(workspaces).values({
      id: workspaceId,
      name: `${fullName}'s Workspace`,
      type: "PERSONAL",
      ownerId: user.id,
      slug: await generateUniqueSlug(tx, fullName),
    });

    await tx.insert(workspaceMembers).values({
      workspaceId,
      userId: user.id,
      role: "OWNER",
    });

    await tx.execute(sql`
      INSERT INTO activity_logs (workspace_id, user_id, action, metadata)
      VALUES (${workspaceId}, ${user.id}, 'workspace.created', '{"reason": "superadmin_created_user"}'::jsonb)
    `);

    return {
      userId: user.id,
      personalWorkspaceId: workspaceId,
      email: normalizedEmail,
      fullName,
      isSuperAdmin: user.isSuperAdmin,
    };
  });
}

/** Roster for the superadmin "Users" admin page. */
export async function listAllUsers(actingUserId: string) {
  if (!(await isSuperAdmin(actingUserId))) {
    throw new NotAuthorizedError("Only a super admin can view the user roster.");
  }

  return db.query.users.findMany({
    orderBy: (u, { desc }) => [desc(u.createdAt)],
    columns: {
      id: true,
      email: true,
      fullName: true,
      contactNumber: true,
      businessName: true,
      businessAddress: true,
      isSuperAdmin: true,
      mustResetPassword: true,
      createdAt: true,
    },
  });
}

/** Toggle a user's platform-level role (promote/demote super admin). */
export async function setUserSuperAdminRole(params: { targetUserId: string; isSuperAdmin: boolean; actingUserId: string }) {
  if (!(await isSuperAdmin(params.actingUserId))) {
    throw new NotAuthorizedError("Only a super admin can change a user's role.");
  }
  if (params.targetUserId === params.actingUserId && !params.isSuperAdmin) {
    throw new ValidationError("You can't remove your own super admin access.");
  }

  await db.update(users).set({ isSuperAdmin: params.isSuperAdmin, updatedAt: new Date() }).where(eq(users.id, params.targetUserId));
}

async function generateUniqueSlug(tx: any, fullName: string): Promise<string> {
  const base = fullName.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 40);
  let candidate = `${base}-${Math.random().toString(36).slice(2, 8)}`;
  const clash = await tx.query.workspaces.findFirst({
    where: (w: any, { eq }: any) => eq(w.slug, candidate),
  });
  if (clash) candidate = `${base}-${Math.random().toString(36).slice(2, 10)}`;
  return candidate;
}
