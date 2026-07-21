/**
 * Thin notification adapters. Swap implementations (Resend/SES for email,
 * a notifications table + WebSocket push for in-app) without touching
 * invitations.ts.
 */

export async function sendInviteEmail(params: {
  to: string;
  rawToken: string;
  projectId: string;
  isExistingUser: boolean;
}) {
  const url = new URL(`${process.env.APP_URL}/invites/accept`);
  url.searchParams.set("token", params.rawToken);
  if (!params.isExistingUser) url.searchParams.set("signup", "1");

  // Replace with real email provider (Resend, SES, Postmark...).
  console.info(`[email] invite -> ${params.to}: ${url.toString()}`);
}

export async function sendInAppNotification(params: {
  userId: string;
  type: "PROJECT_INVITE" | "TASK_ASSIGNED" | "MENTION";
  payload: Record<string, unknown>;
}) {
  // Insert into a `notifications` table (omitted from the core schema
  // above for brevity) and push over the Socket.io channel for that user
  // if they have an active connection (see realtime/socket-server.ts).
  console.info(`[notification] ${params.userId} <- ${params.type}`, params.payload);
}
