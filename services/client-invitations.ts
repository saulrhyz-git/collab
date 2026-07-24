/**
 * Client invitation service — invite someone by email to a CLIENT-scope
 * custom role, granting access across every one of that client's
 * engagements at once. Mirrors services/invitations.ts's project-invite
 * flow exactly (sha256'd token, 7-day expiry, replay-safe acceptance).
 */

import { randomBytes, createHash } from "crypto";
import { eq, and } from "drizzle-orm";
import { db } from "../db/client";
import { clientInvitations, clientMembers, clients, customRoles, workspaceMembers, users, activityLogs } from "../db/schema";
import { sendInviteEmail, sendInAppNotification } from "./notifications";
import { isSuperAdmin } from "../auth/super-admin";

const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

export class NotAuthorizedError extends Error {}
export class NotFoundError extends Error {}
export class InvalidInviteError extends Error {}
export class InviteAlreadyResolvedError extends Error {}
export class InviteExpiredError extends Error {}
export class ValidationError extends Error {}

function hashToken(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

async function assertCanInvite(clientId: string, inviterId: string) {
  const client = await db.query.clients.findFirst({ where: eq(clients.id, clientId) });
  if (!client) throw new NotFoundError("Client not found.");

  if (await isSuperAdmin(inviterId)) return client;

  const workspaceMembership = await db.query.workspaceMembers.findFirst({
    where: and(eq(workspaceMembers.workspaceId, client.workspaceId), eq(workspaceMembers.userId, inviterId)),
  });
  const isWorkspaceAdmin = workspaceMembership?.role === "OWNER" || workspaceMembership?.role === "ADMIN";
  const isCreator = client.createdBy === inviterId;
  const isClientMember = !!(await db.query.clientMembers.findFirst({
    where: and(eq(clientMembers.clientId, clientId), eq(clientMembers.userId, inviterId)),
  }));

  if (!isWorkspaceAdmin && !isCreator && !isClientMember) {
    throw new NotAuthorizedError("You don't have permission to invite collaborators to this client.");
  }

  return client;
}

export async function sendClientInvite(params: {
  clientId: string;
  inviterId: string;
  targetEmail: string;
  customRoleId: string;
}) {
  const targetEmail = params.targetEmail.trim().toLowerCase();
  const client = await assertCanInvite(params.clientId, params.inviterId);

  const role = await db.query.customRoles.findFirst({ where: eq(customRoles.id, params.customRoleId) });
  if (!role) throw new NotFoundError("Custom role not found.");
  if (role.scope !== "CLIENT") {
    throw new ValidationError("Only CLIENT-scoped custom roles can be granted via a client invite.");
  }

  const existingUser = await db.query.users.findFirst({ where: eq(users.email, targetEmail) });

  const existingPending = await db.query.clientInvitations.findFirst({
    where: and(
      eq(clientInvitations.clientId, params.clientId),
      eq(clientInvitations.inviteeEmail, targetEmail),
      eq(clientInvitations.status, "PENDING")
    ),
  });
  if (existingPending) throw new InvalidInviteError("An invitation is already pending for this email.");

  if (existingUser) {
    const alreadyMember = await db.query.clientMembers.findFirst({
      where: and(eq(clientMembers.clientId, params.clientId), eq(clientMembers.userId, existingUser.id)),
    });
    if (alreadyMember) throw new InvalidInviteError("This user already has access to the client.");
  }

  const rawToken = randomBytes(32).toString("hex");
  const tokenHash = hashToken(rawToken);
  const expiresAt = new Date(Date.now() + INVITE_TTL_MS);

  const [invite] = await db
    .insert(clientInvitations)
    .values({
      clientId: params.clientId,
      workspaceId: client.workspaceId,
      inviterId: params.inviterId,
      inviteeEmail: targetEmail,
      inviteeUserId: existingUser?.id ?? null,
      customRoleId: params.customRoleId,
      token: tokenHash,
      status: "PENDING",
      expiresAt,
    })
    .returning();

  await db.insert(activityLogs).values({
    workspaceId: client.workspaceId,
    userId: params.inviterId,
    action: "client_invite.sent",
    metadata: { inviteId: invite.id, clientId: params.clientId, targetEmail, customRoleId: params.customRoleId },
  });

  if (existingUser) {
    await sendInAppNotification({
      userId: existingUser.id,
      type: "CLIENT_INVITE",
      payload: { inviteId: invite.id, clientId: params.clientId },
    });
    await sendInviteEmail({ to: targetEmail, rawToken, projectId: params.clientId, isExistingUser: true });
  } else {
    await sendInviteEmail({ to: targetEmail, rawToken, projectId: params.clientId, isExistingUser: false });
  }

  return { inviteId: invite.id, expiresAt };
}

export async function acceptClientInvite(params: {
  inviteTokenOrId: string;
  acceptingUserId: string;
  lookupBy: "token" | "id";
}) {
  const invite =
    params.lookupBy === "token"
      ? await db.query.clientInvitations.findFirst({ where: eq(clientInvitations.token, hashToken(params.inviteTokenOrId)) })
      : await db.query.clientInvitations.findFirst({ where: eq(clientInvitations.id, params.inviteTokenOrId) });

  if (!invite) throw new InvalidInviteError("Invitation not found.");

  if (params.lookupBy === "id" && invite.inviteeUserId && invite.inviteeUserId !== params.acceptingUserId) {
    throw new NotAuthorizedError("This invitation was not addressed to you.");
  }
  if (invite.status !== "PENDING") {
    throw new InviteAlreadyResolvedError(`Invitation already ${invite.status.toLowerCase()}.`);
  }
  if (invite.expiresAt.getTime() < Date.now()) {
    await db.update(clientInvitations).set({ status: "EXPIRED" }).where(eq(clientInvitations.id, invite.id));
    throw new InviteExpiredError("This invitation has expired.");
  }

  const acceptingUser = await db.query.users.findFirst({ where: eq(users.id, params.acceptingUserId) });
  if (!acceptingUser || acceptingUser.email.toLowerCase() !== invite.inviteeEmail.toLowerCase()) {
    throw new NotAuthorizedError("This invitation was issued to a different email address.");
  }

  await db.transaction(async (tx) => {
    // Unique index is (clientId, userId, customRoleId) — see
    // services/client-members.ts's addClientMember for why this is
    // onConflictDoNothing rather than an update now.
    await tx
      .insert(clientMembers)
      .values({
        clientId: invite.clientId,
        workspaceId: invite.workspaceId,
        userId: params.acceptingUserId,
        customRoleId: invite.customRoleId,
        invitedBy: invite.inviterId,
      })
      .onConflictDoNothing({
        target: [clientMembers.clientId, clientMembers.userId, clientMembers.customRoleId],
      });

    await tx
      .update(clientInvitations)
      .set({ status: "ACCEPTED", acceptedAt: new Date(), inviteeUserId: params.acceptingUserId })
      .where(eq(clientInvitations.id, invite.id));

    await tx.insert(activityLogs).values({
      workspaceId: invite.workspaceId,
      userId: params.acceptingUserId,
      action: "client_invite.accepted",
      metadata: { inviteId: invite.id, clientId: invite.clientId },
    });
  });

  return { clientId: invite.clientId, workspaceId: invite.workspaceId };
}

export async function revokeClientInvite(params: { inviteId: string; actingUserId: string }) {
  const invite = await db.query.clientInvitations.findFirst({ where: eq(clientInvitations.id, params.inviteId) });
  if (!invite) throw new InvalidInviteError("Invitation not found.");
  if (invite.status !== "PENDING") {
    throw new InviteAlreadyResolvedError(`Cannot revoke — invitation is already ${invite.status.toLowerCase()}.`);
  }

  const workspaceMembership = await db.query.workspaceMembers.findFirst({
    where: and(eq(workspaceMembers.workspaceId, invite.workspaceId), eq(workspaceMembers.userId, params.actingUserId)),
  });
  const isWorkspaceAdmin = workspaceMembership?.role === "OWNER" || workspaceMembership?.role === "ADMIN";

  if (invite.inviterId !== params.actingUserId && !isWorkspaceAdmin && !(await isSuperAdmin(params.actingUserId))) {
    throw new NotAuthorizedError("Only the inviter or a workspace admin can revoke this invitation.");
  }

  await db.update(clientInvitations).set({ status: "REVOKED", revokedAt: new Date() }).where(eq(clientInvitations.id, invite.id));

  await db.insert(activityLogs).values({
    workspaceId: invite.workspaceId,
    userId: params.actingUserId,
    action: "client_invite.revoked",
    metadata: { inviteId: invite.id },
  });
}

export async function listClientInvitations(params: {
  clientId: string;
  requestingUserId: string;
  status?: "PENDING" | "ACCEPTED" | "DECLINED" | "EXPIRED" | "REVOKED";
}) {
  await assertCanInvite(params.clientId, params.requestingUserId);

  return db.query.clientInvitations.findMany({
    where: params.status
      ? and(eq(clientInvitations.clientId, params.clientId), eq(clientInvitations.status, params.status))
      : eq(clientInvitations.clientId, params.clientId),
    orderBy: (inv, { desc }) => [desc(inv.createdAt)],
    columns: { id: true, inviteeEmail: true, customRoleId: true, status: true, expiresAt: true, createdAt: true },
  });
}
