/**
 * Symmetric encryption for secrets we must store but never need to search
 * or index on — SMTP passwords, OpenAI/Gemini API keys. AES-256-GCM: the
 * auth tag gives us tamper detection for free (a corrupted or truncated
 * ciphertext throws on decrypt rather than silently returning garbage).
 *
 * ENCRYPTION_KEY must be a 32-byte key, base64-encoded (44 chars). Generate
 * one with:
 *   node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
 *
 * Ciphertext is stored as a single string: base64(iv) + "." + base64(authTag)
 * + "." + base64(encrypted) — self-contained, so no separate columns are
 * needed for iv/tag, and the format is versionable later (e.g. a leading
 * "v2:" prefix) without a migration touching every existing row.
 */

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12; // 96-bit IV is the recommended size for GCM

function getKey(): Buffer {
  const raw = process.env.ENCRYPTION_KEY;
  if (!raw) {
    throw new Error(
      "ENCRYPTION_KEY is not set. Generate one with: node -e \"console.log(require('crypto').randomBytes(32).toString('base64'))\" and add it to your .env."
    );
  }
  const key = Buffer.from(raw, "base64");
  if (key.length !== 32) {
    throw new Error("ENCRYPTION_KEY must decode to exactly 32 bytes (base64-encoded AES-256 key).");
  }
  return key;
}

export function encryptSecret(plaintext: string): string {
  const key = getKey();
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return [iv.toString("base64"), authTag.toString("base64"), encrypted.toString("base64")].join(".");
}

export function decryptSecret(ciphertext: string): string {
  const key = getKey();
  const parts = ciphertext.split(".");
  if (parts.length !== 3) {
    throw new Error("Malformed ciphertext — expected iv.authTag.encrypted.");
  }
  const [ivB64, authTagB64, encryptedB64] = parts;
  const iv = Buffer.from(ivB64, "base64");
  const authTag = Buffer.from(authTagB64, "base64");
  const encrypted = Buffer.from(encryptedB64, "base64");

  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);
  const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
  return decrypted.toString("utf8");
}

/**
 * Masks a decrypted secret for display in a settings UI — shows just
 * enough to confirm "yes, a key is saved" and tell keys apart, never the
 * full value. e.g. "sk-abc123...789xyz" -> "sk-a…9xyz".
 */
export function maskSecret(plaintext: string): string {
  if (plaintext.length <= 8) return "•".repeat(plaintext.length);
  return `${plaintext.slice(0, 4)}…${plaintext.slice(-4)}`;
}
