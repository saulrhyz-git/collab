/**
 * "Review via AI" — sends a document's extracted text to whichever
 * provider (OpenAI or Gemini) is configured/selected, and asks for a
 * structured legal-document review: a plain-language summary,
 * recommendations, and notable clauses/risks. Built for the kind of
 * documents this app's engagements actually produce — contracts, MOAs,
 * other legal documents — not general-purpose Q&A.
 *
 * Gated by the 'ai_review.run' permission (PROJECT scope, matrix-governed
 * — see services/permissions.ts) rather than an RLS policy, since running
 * a review isn't a database write in itself; the result gets persisted
 * onto the file's row afterward, at which point ordinary project_files
 * RLS covers who can see it.
 */

import { eq } from "drizzle-orm";
import { db } from "../db/client";
import { projectFiles } from "../db/schema";
import { requireProjectAccess, NotFoundError, NotAuthorizedError } from "./tasks";
import { userHasProjectPermission } from "./permissions";
import { isSuperAdmin } from "../auth/super-admin";
import { getAiProviderCredentials, getDefaultAiProvider } from "./ai-provider-settings";
import { extractTextFromDocument } from "../lib/document-text-extraction";
import { readStoredFile } from "../lib/file-storage";

export { NotFoundError, NotAuthorizedError };
export class AiNotConfiguredError extends Error {}
export class AiReviewFailedError extends Error {}

type Provider = "openai" | "gemini";

export interface AiReviewResult {
  summary: string;
  recommendations: string[];
  notables: string[];
  provider: Provider;
  model: string;
}

const SYSTEM_PROMPT = `You are a meticulous legal document reviewer helping a business
professional understand a contract, memorandum of agreement, or other legal
document before they sign or act on it. You are not a lawyer and your output
is not legal advice — the caller will present it that way to the user.

Respond with ONLY a JSON object of this exact shape, no other text:
{
  "summary": "a plain-language summary of what the document is and does, 2-4 sentences",
  "recommendations": ["actionable recommendation", "..."],
  "notables": ["a notable clause, risk, obligation, or ambiguity worth the reader's attention", "..."]
}

"recommendations" are things the reader should consider doing (e.g. "negotiate
the indemnification cap", "confirm the termination notice period with counsel").
"notables" are things worth flagging as-is (e.g. unusual clauses, one-sided
terms, missing definitions, auto-renewal terms). Keep each array to the most
important 3-8 items — don't pad it. If the document doesn't look like a legal
document at all, say so plainly in "summary" and leave the arrays empty.`;

async function assertCanRunReview(projectId: string, workspaceId: string, actingUserId: string) {
  const role = await requireProjectAccess(projectId, workspaceId, actingUserId);
  if (await isSuperAdmin(actingUserId)) return;
  if (await userHasProjectPermission(role, actingUserId, "ai_review.run")) return;
  throw new NotAuthorizedError("You don't have permission to run an AI review on this engagement.");
}

function parseModelJson(raw: string): { summary: string; recommendations: string[]; notables: string[] } {
  // Models sometimes wrap JSON in a fenced code block despite instructions
  // not to — strip that before parsing rather than failing the whole review
  // over formatting.
  const cleaned = raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "");
  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    throw new AiReviewFailedError("The AI provider returned a response that couldn't be parsed.");
  }
  const obj = parsed as Record<string, unknown>;
  if (typeof obj.summary !== "string" || !Array.isArray(obj.recommendations) || !Array.isArray(obj.notables)) {
    throw new AiReviewFailedError("The AI provider's response was missing expected fields.");
  }
  return {
    summary: obj.summary,
    recommendations: obj.recommendations.filter((x): x is string => typeof x === "string"),
    notables: obj.notables.filter((x): x is string => typeof x === "string"),
  };
}

async function callOpenAi(apiKey: string, model: string, documentText: string) {
  const { default: OpenAI } = await import("openai");
  const client = new OpenAI({ apiKey });

  const completion = await client.chat.completions.create({
    model,
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: `Document to review:\n\n${documentText}` },
    ],
    response_format: { type: "json_object" },
    temperature: 0.2,
  });

  const raw = completion.choices[0]?.message?.content;
  if (!raw) throw new AiReviewFailedError("The AI provider returned an empty response.");
  return parseModelJson(raw);
}

async function callGemini(apiKey: string, model: string, documentText: string) {
  const { GoogleGenerativeAI } = await import("@google/generative-ai");
  const genAI = new GoogleGenerativeAI(apiKey);
  const generativeModel = genAI.getGenerativeModel({
    model,
    generationConfig: { responseMimeType: "application/json", temperature: 0.2 },
  });

  const result = await generativeModel.generateContent(
    `${SYSTEM_PROMPT}\n\nDocument to review:\n\n${documentText}`
  );
  const raw = result.response.text();
  if (!raw) throw new AiReviewFailedError("The AI provider returned an empty response.");
  return parseModelJson(raw);
}

export async function reviewProjectFile(params: {
  fileId: string;
  actingUserId: string;
  /** Overrides the platform's configured default provider for this one review. */
  provider?: Provider;
}): Promise<AiReviewResult> {
  const file = await db.query.projectFiles.findFirst({ where: eq(projectFiles.id, params.fileId) });
  if (!file) throw new NotFoundError("File not found.");

  await assertCanRunReview(file.projectId, file.workspaceId, params.actingUserId);

  const provider = params.provider ?? (await getDefaultAiProvider());
  const credentials = await getAiProviderCredentials(provider);
  if (!credentials) {
    throw new AiNotConfiguredError(
      `${provider === "openai" ? "OpenAI" : "Gemini"} isn't configured yet — add an API key in AI provider settings.`
    );
  }

  const buffer = await readStoredFile(file.storagePath);
  const documentText = await extractTextFromDocument(buffer, file.mimeType ?? "", file.fileName);

  if (documentText.length === 0) {
    throw new AiReviewFailedError("No extractable text was found in this document.");
  }

  const analysis =
    provider === "openai"
      ? await callOpenAi(credentials.apiKey, credentials.model, documentText)
      : await callGemini(credentials.apiKey, credentials.model, documentText);

  const summaryForStorage = JSON.stringify({ ...analysis, provider, model: credentials.model });
  await db
    .update(projectFiles)
    .set({ aiReviewSummary: summaryForStorage, category: "AI_REVIEWED" })
    .where(eq(projectFiles.id, params.fileId));

  return { ...analysis, provider, model: credentials.model };
}

/** Parses whatever's stored in project_files.ai_review_summary back into structured form for display. */
export function parseStoredAiReview(raw: string | null): AiReviewResult | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed.summary === "string" && Array.isArray(parsed.recommendations) && Array.isArray(parsed.notables)) {
      return parsed as AiReviewResult;
    }
    return null;
  } catch {
    return null;
  }
}
