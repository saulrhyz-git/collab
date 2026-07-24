/**
 * Self-service profile management — the "manage your own account" surface,
 * distinct from services/users-admin.ts (superadmin managing OTHER
 * accounts). A user can only ever act on their own row here; there's no
 * targetUserId parameter anywhere in this file on purpose.
 */

// See auth/signup.ts for why bcryptjs can't use a named import.
import bcryptjs from "bcryptjs";
const { hash, compare } = bcryptjs;
import { eq } from "drizzle-orm";
import { db } from "../db/client";
import { users } from "../db/schema";

export class NotFoundError extends Error {}
export class ValidationError extends Error {}
export class IncorrectPasswordError extends Error {}
export class EmailAlreadyRegisteredError extends Error {
  constructor() {
    super("An account with this email already exists.");
    this.name = "EmailAlreadyRegisteredError";
  }
}

const MIN_PASSWORD_LENGTH = 8;

const PROFILE_COLUMNS = {
  id: true,
  email: true,
  fullName: true,
  avatarUrl: true,
  contactNumber: true,
  businessName: true,
  businessAddress: true,
  isSuperAdmin: true,
  mustResetPassword: true,
  createdAt: true,
} as const;

export async function getOwnProfile(userId: string) {
  const user = await db.query.users.findFirst({ where: eq(users.id, userId), columns: PROFILE_COLUMNS });
  if (!user) throw new NotFoundError("User not found.");
  return user;
}

/**
 * Everyone can edit their own name/contact/business fields and (unlike the
 * superadmin edit path) their avatar — email changes go through the same
 * uniqueness check services/users-admin.ts's updateUserBySuperAdmin does.
 * Role (isSuperAdmin) is deliberately not editable here at all.
 */
export async function updateOwnProfile(params: {
  userId: string;
  fullName?: string;
  email?: string;
  contactNumber?: string | null;
  businessName?: string | null;
  businessAddress?: string | null;
  avatarUrl?: string | null;
}) {
  const existing = await db.query.users.findFirst({ where: eq(users.id, params.userId) });
  if (!existing) throw new NotFoundError("User not found.");

  let normalizedEmail: string | undefined;
  if (params.email !== undefined) {
    normalizedEmail = params.email.trim().toLowerCase();
    if (!normalizedEmail) throw new ValidationError("Email address is required.");
    if (normalizedEmail !== existing.email) {
      const clash = await db.query.users.findFirst({ where: eq(users.email, normalizedEmail) });
      if (clash) throw new EmailAlreadyRegisteredError();
    }
  }

  if (params.fullName !== undefined && !params.fullName.trim()) {
    throw new ValidationError("Full name is required.");
  }

  await db
    .update(users)
    .set({
      ...(params.fullName !== undefined ? { fullName: params.fullName.trim() } : {}),
      ...(normalizedEmail !== undefined ? { email: normalizedEmail } : {}),
      ...(params.contactNumber !== undefined ? { contactNumber: params.contactNumber?.trim() || null } : {}),
      ...(params.businessName !== undefined ? { businessName: params.businessName?.trim() || null } : {}),
      ...(params.businessAddress !== undefined ? { businessAddress: params.businessAddress?.trim() || null } : {}),
      ...(params.avatarUrl !== undefined ? { avatarUrl: params.avatarUrl } : {}),
      updatedAt: new Date(),
    })
    .where(eq(users.id, params.userId));

  return getOwnProfile(params.userId);
}

/**
 * Requires the current password (except for a superadmin-assigned account
 * that's never had one confirmed — mustResetPassword true and, in practice,
 * the temporary password itself serves as "current" here) so a hijacked
 * session with a stolen cookie but no known password can't silently take
 * over the account's credentials. Clears mustResetPassword — this IS the
 * reset the flag was waiting for.
 */
export async function changeOwnPassword(params: { userId: string; currentPassword: string; newPassword: string }) {
  const user = await db.query.users.findFirst({ where: eq(users.id, params.userId) });
  if (!user) throw new NotFoundError("User not found.");
  if (!user.passwordHash) {
    throw new ValidationError("This account signs in via an external provider and has no password to change.");
  }

  const valid = await compare(params.currentPassword, user.passwordHash);
  if (!valid) throw new IncorrectPasswordError("Current password is incorrect.");

  if (!params.newPassword || params.newPassword.length < MIN_PASSWORD_LENGTH) {
    throw new ValidationError(`New password must be at least ${MIN_PASSWORD_LENGTH} characters.`);
  }

  const passwordHash = await hash(params.newPassword, 12);
  await db
    .update(users)
    .set({ passwordHash, mustResetPassword: false, updatedAt: new Date() })
    .where(eq(users.id, params.userId));
}
