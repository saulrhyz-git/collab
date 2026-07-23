/**
 * Turns an uploaded document's raw bytes into plain text for the AI review
 * prompt (services/ai-review.ts). Contracts and MOAs show up as PDF, Word,
 * or plain text/markdown in practice — everything else is rejected with a
 * clear error rather than silently sending garbage to the model.
 *
 * Extracted text is capped (~100k characters, comfortably inside every
 * mainstream model's context window at the token-to-char ratios that
 * matter here) so an unusually large document degrades gracefully — the
 * user gets a review of the truncated document rather than an opaque
 * "request too large" error from the provider.
 */

import mammoth from "mammoth";
// pdf-parse's root export is what @types/pdf-parse declares types for.
// (Its debug self-test in index.js is gated on `!module.parent`, so it
// never fires when the package is required as a module like this — only
// when run directly as a script.)
import pdfParse from "pdf-parse";

const MAX_CHARS = 100_000;

export class UnsupportedDocumentTypeError extends Error {}

function truncate(text: string): string {
  const trimmed = text.trim();
  if (trimmed.length <= MAX_CHARS) return trimmed;
  return trimmed.slice(0, MAX_CHARS) + "\n\n[...document truncated for length...]";
}

export async function extractTextFromDocument(
  buffer: Buffer,
  mimeType: string,
  fileName: string
): Promise<string> {
  const lowerName = fileName.toLowerCase();

  if (mimeType === "application/pdf" || lowerName.endsWith(".pdf")) {
    const parsed = await pdfParse(buffer);
    return truncate(parsed.text);
  }

  if (
    mimeType === "application/vnd.openxmlformats-officedocument.wordprocessingml.document" ||
    lowerName.endsWith(".docx")
  ) {
    const { value } = await mammoth.extractRawText({ buffer });
    return truncate(value);
  }

  if (mimeType.startsWith("text/") || lowerName.endsWith(".txt") || lowerName.endsWith(".md")) {
    return truncate(buffer.toString("utf-8"));
  }

  throw new UnsupportedDocumentTypeError(
    "AI review supports PDF, Word (.docx), and plain text/markdown documents."
  );
}
