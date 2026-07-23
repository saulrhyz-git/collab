/**
 * SMTP settings — a single platform-wide row (id fixed to 1). Superadmin
 * manages it through /admin/smtp-settings; services/notifications.ts reads
 * it (via getSmtpSettingsForSending, unguarded — it's an internal app call,
 * not a user-facing read) to actually send invite/notification email.
 *
 * The password is encrypted at rest (lib/crypto-secrets.ts) and NEVER
 * returned decrypted to the admin UI — getSmtpSettingsForAdmin only ever
 * reports whether a password is currently set, matching the RLS comment's
 * promise that "the encrypted secret columns are never sent to the client."
 */

import { eq } from "drizzle-orm";
import { db } from "../db/client";
import { smtpSettings } from "../db/schema";
import { isSuperAdmin } from "../auth/super-admin";
import { encryptSecret, decryptSecret } from "../lib/crypto-secrets";

export class NotAuthorizedError extends Error {}

async function assertSuperAdmin(userId: string) {
  if (!(await isSuperAdmin(userId))) {
    throw new NotAuthorizedError("Only a super admin can manage SMTP settings.");
  }
}

async function getRow() {
  return db.query.smtpSettings.findFirst({ where: eq(smtpSettings.id, 1) });
}

export async function getSmtpSettingsForAdmin(actingUserId: string) {
  await assertSuperAdmin(actingUserId);
  const row = await getRow();
  return {
    host: row?.host ?? null,
    port: row?.port ?? 587,
    username: row?.username ?? null,
    fromAddress: row?.fromAddress ?? null,
    fromName: row?.fromName ?? null,
    secure: row?.secure ?? false,
    hasPassword: !!row?.encryptedPassword,
    updatedAt: row?.updatedAt ?? null,
  };
}

export async function updateSmtpSettings(params: {
  actingUserId: string;
  host?: string | null;
  port?: number;
  username?: string | null;
  /** Omitted or undefined keeps the existing stored password; empty string clears it. */
  password?: string;
  fromAddress?: string | null;
  fromName?: string | null;
  secure?: boolean;
}) {
  await assertSuperAdmin(params.actingUserId);

  const existing = await getRow();
  const encryptedPassword =
    params.password === undefined
      ? existing?.encryptedPassword ?? null
      : params.password === ""
        ? null
        : encryptSecret(params.password);

  const values = {
    id: 1,
    host: params.host !== undefined ? params.host : (existing?.host ?? null),
    port: params.port !== undefined ? params.port : (existing?.port ?? 587),
    username: params.username !== undefined ? params.username : (existing?.username ?? null),
    encryptedPassword,
    fromAddress: params.fromAddress !== undefined ? params.fromAddress : (existing?.fromAddress ?? null),
    fromName: params.fromName !== undefined ? params.fromName : (existing?.fromName ?? null),
    secure: params.secure !== undefined ? params.secure : (existing?.secure ?? false),
    updatedAt: new Date(),
    updatedBy: params.actingUserId,
  };

  await db
    .insert(smtpSettings)
    .values(values)
    .onConflictDoUpdate({ target: smtpSettings.id, set: values });

  return getSmtpSettingsForAdmin(params.actingUserId);
}

/**
 * Internal, app-level read for services/notifications.ts — no permission
 * gate (mirrors RLS: SELECT is open to any authenticated session so the
 * app can send email on behalf of ordinary users). Returns null if SMTP
 * hasn't been configured yet, so callers can fall back to a dev-mode log.
 */
export async function getSmtpSettingsForSending() {
  const row = await getRow();
  if (!row?.host || !row.encryptedPassword || !row.fromAddress) return null;
  return {
    host: row.host,
    port: row.port ?? 587,
    secure: row.secure,
    username: row.username,
    password: decryptSecret(row.encryptedPassword),
    fromAddress: row.fromAddress,
    fromName: row.fromName,
  };
}
