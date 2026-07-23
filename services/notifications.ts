/**
 * Thin notification adapters. Email now goes through whatever SMTP server
 * a super admin has configured at /admin/smtp-settings (see
 * services/smtp-settings.ts) via nodemailer; if nothing's configured yet
 * (fresh install, local dev), it falls back to logging the link to the
 * console so the flow is still testable without setting up a mail server.
 */

import nodemailer from "nodemailer";
import { getSmtpSettingsForSending } from "./smtp-settings";

async function sendEmail(params: { to: string; subject: string; text: string; html?: string }) {
  const smtp = await getSmtpSettingsForSending();

  if (!smtp) {
    console.info(`[email:dev-mode, no SMTP configured] to=${params.to} subject="${params.subject}"\n${params.text}`);
    return;
  }

  const transporter = nodemailer.createTransport({
    host: smtp.host,
    port: smtp.port,
    secure: smtp.secure,
    auth: smtp.username ? { user: smtp.username, pass: smtp.password } : undefined,
  });

  await transporter.sendMail({
    from: smtp.fromName ? `"${smtp.fromName}" <${smtp.fromAddress}>` : smtp.fromAddress,
    to: params.to,
    subject: params.subject,
    text: params.text,
    html: params.html,
  });
}

export async function sendInviteEmail(params: {
  to: string;
  rawToken: string;
  projectId: string;
  isExistingUser: boolean;
}) {
  const url = new URL(`${process.env.APP_URL}/invites/accept`);
  url.searchParams.set("token", params.rawToken);
  if (!params.isExistingUser) url.searchParams.set("signup", "1");

  await sendEmail({
    to: params.to,
    subject: "You've been invited to an engagement",
    text: `You've been invited to collaborate on an engagement. Accept here: ${url.toString()}`,
    html: `<p>You've been invited to collaborate on an engagement.</p><p><a href="${url.toString()}">Accept the invitation</a></p>`,
  });
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
