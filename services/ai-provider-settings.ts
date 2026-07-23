/**
 * AI provider settings — a single platform-wide row (id fixed to 1)
 * holding the OpenAI/Gemini API keys and which model each should use.
 * Model names are free-choice fields, not hardcoded — "gpt-4o" and
 * "gemini-1.5-pro" are just defaults; a super admin can point this at
 * whatever model string their account currently has access to (model
 * lineups change faster than this code does). Same shape as
 * services/smtp-settings.ts: superadmin-only to view/edit via the admin
 * UI, keys encrypted at rest and never sent to the client in decrypted
 * form; services/ai-review.ts reads the decrypted keys internally to
 * actually call the provider APIs.
 */

import { eq } from "drizzle-orm";
import { db } from "../db/client";
import { aiProviderSettings } from "../db/schema";
import { isSuperAdmin } from "../auth/super-admin";
import { encryptSecret, decryptSecret } from "../lib/crypto-secrets";

export class NotAuthorizedError extends Error {}

type Provider = "openai" | "gemini";

async function assertSuperAdmin(userId: string) {
  if (!(await isSuperAdmin(userId))) {
    throw new NotAuthorizedError("Only a super admin can manage AI provider settings.");
  }
}

async function getRow() {
  return db.query.aiProviderSettings.findFirst({ where: eq(aiProviderSettings.id, 1) });
}

export async function getAiProviderSettingsForAdmin(actingUserId: string) {
  await assertSuperAdmin(actingUserId);
  const row = await getRow();
  return {
    openaiModel: row?.openaiModel ?? "gpt-4o",
    hasOpenaiKey: !!row?.openaiEncryptedKey,
    geminiModel: row?.geminiModel ?? "gemini-1.5-pro",
    hasGeminiKey: !!row?.geminiEncryptedKey,
    defaultProvider: (row?.defaultProvider as Provider | undefined) ?? "openai",
    updatedAt: row?.updatedAt ?? null,
  };
}

export async function updateAiProviderSettings(params: {
  actingUserId: string;
  openaiModel?: string;
  /** Omitted keeps the existing key; empty string clears it. */
  openaiKey?: string;
  geminiModel?: string;
  geminiKey?: string;
  defaultProvider?: Provider;
}) {
  await assertSuperAdmin(params.actingUserId);

  const existing = await getRow();

  const openaiEncryptedKey =
    params.openaiKey === undefined
      ? existing?.openaiEncryptedKey ?? null
      : params.openaiKey === ""
        ? null
        : encryptSecret(params.openaiKey);

  const geminiEncryptedKey =
    params.geminiKey === undefined
      ? existing?.geminiEncryptedKey ?? null
      : params.geminiKey === ""
        ? null
        : encryptSecret(params.geminiKey);

  const values = {
    id: 1,
    openaiModel: params.openaiModel !== undefined ? params.openaiModel : (existing?.openaiModel ?? "gpt-4o"),
    openaiEncryptedKey,
    geminiModel: params.geminiModel !== undefined ? params.geminiModel : (existing?.geminiModel ?? "gemini-1.5-pro"),
    geminiEncryptedKey,
    defaultProvider:
      params.defaultProvider !== undefined ? params.defaultProvider : (existing?.defaultProvider ?? "openai"),
    updatedAt: new Date(),
    updatedBy: params.actingUserId,
  };

  await db
    .insert(aiProviderSettings)
    .values(values)
    .onConflictDoUpdate({ target: aiProviderSettings.id, set: values });

  return getAiProviderSettingsForAdmin(params.actingUserId);
}

/**
 * Internal, app-level read for services/ai-review.ts — no permission gate,
 * same reasoning as getSmtpSettingsForSending(). Returns the decrypted key
 * and model for whichever provider is requested, or null if that provider
 * isn't configured yet.
 */
export async function getAiProviderCredentials(provider: Provider) {
  const row = await getRow();
  if (!row) return null;

  if (provider === "openai") {
    if (!row.openaiEncryptedKey) return null;
    return { apiKey: decryptSecret(row.openaiEncryptedKey), model: row.openaiModel ?? "gpt-4o" };
  }
  if (!row.geminiEncryptedKey) return null;
  return { apiKey: decryptSecret(row.geminiEncryptedKey), model: row.geminiModel ?? "gemini-1.5-pro" };
}

export async function getDefaultAiProvider(): Promise<Provider> {
  const row = await getRow();
  return (row?.defaultProvider as Provider | undefined) ?? "openai";
}
