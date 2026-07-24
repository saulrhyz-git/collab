/**
 * Task invitation service — invite someone by email to VIEWER/EDITOR access
 * on exactly one task, without giving them a project_members row (that's
 * what makes this "true task-level ACL" rather than a filtered engagement
 * invite). Mirrors services/invitations.ts's flow (sha256'd token, 7-day
 * expiry, replay-safe acceptance).
 */

import { randomBytes, createHash } from "crypto";
import { eq, and } from "drizzle-orm";
import { db } from "../db/client";
import { taskInvitations, taskMembers, tasks, projectMembers, workspaceMembers, users, activityLogs } from "../db/schema";
import { sendInviteEmail, sendInAppNotification } from "./notifications";
import { isSuperAdmin } from "../auth/super-admin";
import { userHasProjectPermission } from "./permissions";

const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

export class NotAuthorizedError extends Error {}
export class NotFoundError extends Error {}
export class InvalidInviteError extends Error {}
export class InviteAlreadyResolvedError extends Error {}
export class InviteExpiredError extends Error {}

type TaskMemberRole = "VIEWER" | "EDITOR";

function hashToken(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

async function assertCanInvite(taskId: string, inviterId: string) {
  const task = await db.query.tasks.findFirst({ where: eq(tasks.id, taskId) });
  if (!task) throw new NotFoundError("Task not found.");

  if (await isSuperAdmin(inviterId)) return task;

  const workspaceMembership = await db.query.workspaceMembers.findFirst({
    where: and(eq(workspaceMembers.workspaceId, task.workspaceId), eq(workspaceMembers.userId, inviterId)),
  });
  const isWorkspaceAdmin = workspaceMembership?.role === "OWNER" || workspaceMembership?.role === "ADMIN";

  const projectMembership = await db.query.projectMembers.findFirst({
    where: and(eq(projectMembers.projectId, task.projectId), eq(projectMembers.userId, inviterId)),
  });
  const canWriteTasks =
    !!projectMembership && (await userHasProjectPermission(projectMembership.role, inviterId, "task.write"));

  if (!isWorkspaceAdmin && !canWriteTasks) {
    throw new NotAuthorizedError("You don't have permission to share this task.");
  }

  return task;
}

export async function sendTaskInvite(params: {
  taskId: string;
  inviterId: string;
  targetEmail: string;
  role: TaskMemberRole;
}) {
  const targetEmail = params.targetEmail.trim().toLowerCase();
  const task = await assertCanInvite(params.taskId, params.inviterId);

  const existingUser = await db.query.users.findFirst({ where: eq(users.email, targetEmail) });

  const existingPending = await db.query.taskInvitations.findFirst({
    where: and(
      eq(taskInvitations.taskId, params.taskId),
      eq(taskInvitations.inviteeEmail, targetEmail),
      eq(taskInvitations.status, "PENDING")
    ),
  });
  if (existingPending) throw new InvalidInviteError("An invitation is already pending for this email.");

  if (existingUser) {
    const alreadyMember = await db.query.taskMembers.findFirst({
      where: and(eq(taskMembers.taskId, params.taskId), eq(taskMembers.userId, existingUser.id)),
    });
    if (alreadyMember) throw new InvalidInviteError("This user already has access to this task.");
  }

  const rawToken = randomBytes(32).toString("hex");
  const tokenHash = hashToken(rawToken);
  const expiresAt = new Date(Date.now() + INVITE_TTL_MS);

  const [invite] = await db
    .insert(taskInvitations)
    .values({
      taskId: params.taskId,
      projectId: task.projectId,
      workspaceId: task.workspaceId,
      inviterId: params.inviterId,
      inviteeEmail: targetEmail,
      inviteeUserId: existingUser?.id ?? null,
      role: params.role,
      token: tokenHash,
      status: "PENDING",
      expiresAt,
    })
    .returning();

  await db.insert(activityLogs).values({
    workspaceId: task.workspaceId,
    projectId: task.projectId,
    userId: params.inviterId,
    action: "task_invite.sent",
    metadata: { inviteId: invite.id, taskId: params.taskId, targetEmail, role: params.role },
  });

  if (existingUser) {
    await sendInAppNotification({
      userId: existingUser.id,
      type: "TASK_INVITE",
      payload: { inviteId: invite.id, taskId: params.taskId, role: params.role },
    });
    await sendInviteEmail({ to: targetEmail, rawToken, projectId: task.projectId, isExistingUser: true });
  } else {
    await sendInviteEmail({ to: targetEmail, rawToken, projectId: task.projectId, isExistingUser: false });
  }

  return { inviteId: invite.id, expiresAt };
}

export async function acceptTaskInvite(params: {
  inviteTokenOrId: string;
  acceptingUserId: string;
  lookupBy: "token" | "id";
}) {
  const invite =
    params.lookupBy === "token"
      ? await db.query.taskInvitations.findFirst({ where: eq(taskInvitations.token, hashToken(params.inviteTokenOrId)) })
      : await db.query.taskInvitations.findFirst({ where: eq(taskInvitations.id, params.inviteTokenOrId) });

  if (!invite) throw new InvalidInviteError("Invitation not found.");

  if (params.lookupBy === "id" && invite.inviteeUserId && invite.inviteeUserId !== params.acceptingUserId) {
    throw new NotAuthorizedError("This invitation was not addressed to you.");
  }
  if (invite.status !== "PENDING") {
    throw new InviteAlreadyResolvedError(`Invitation already ${invite.status.toLowerCase()}.`);
  }
  if (invite.expiresAt.getTime() < Date.now()) {
    await db.update(taskInvitations).set({ status: "EXPIRED" }).where(eq(taskInvitations.id, invite.id));
    throw new InviteExpiredError("This invitation has expired.");
  }

  const acceptingUser = await db.query.users.findFirst({ where: eq(users.id, params.acceptingUserId) });
  if (!acceptingUser || acceptingUser.email.toLowerCase() !== invite.inviteeEmail.toLowerCase()) {
    throw new NotAuthorizedError("This invitation was issued to a different email address.");
  }

  await db.transaction(async (tx) => {
    await tx
      .insert(taskMembers)
      .values({
        taskId: invite.taskId,
        projectId: invite.projectId,
        workspaceId: invite.workspaceId,
        userId: params.acceptingUserId,
        role: invite.role,
        invitedBy: invite.inviterId,
      })
      .onConflictDoUpdate({
        target: [taskMembers.taskId, taskMembers.userId],
        set: { role: invite.role },
      });

    await tx
      .update(taskInvitations)
      .set({ status: "ACCEPTED", acceptedAt: new Date(), inviteeUserId: params.acceptingUserId })
      .where(eq(taskInvitations.id, invite.id));

    await tx.insert(activityLogs).values({
      workspaceId: invite.workspaceId,
      projectId: invite.projectId,
      userId: params.acceptingUserId,
      action: "task_invite.accepted",
      metadata: { inviteId: invite.id, taskId: invite.taskId, role: invite.role },
    });
  });

  return { taskId: invite.taskId, projectId: invite.projectId, workspaceId: invite.workspaceId, role: invite.role };
}

export async function revokeTaskInvite(params: { inviteId: string; actingUserId: string }) {
  const invite = await db.query.taskInvitations.findFirst({ where: eq(taskInvitations.id, params.inviteId) });
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

  await db.update(taskInvitations).set({ status: "REVOKED", revokedAt: new Date() }).where(eq(taskInvitations.id, invite.id));

  await db.insert(activityLogs).values({
    workspaceId: invite.workspaceId,
    projectId: invite.projectId,
    userId: params.actingUserId,
    action: "task_invite.revoked",
    metadata: { inviteId: invite.id },
  });
}

export async function listTaskInvitations(params: {
  taskId: string;
  requestingUserId: string;
  status?: "PENDING" | "ACCEPTED" | "DECLINED" | "EXPIRED" | "REVOKED";
}) {
  await assertCanInvite(params.taskId, params.requestingUserId);

  return db.query.taskInvitations.findMany({
    where: params.status
      ? and(eq(taskInvitations.taskId, params.taskId), eq(taskInvitations.status, params.status))
      : eq(taskInvitations.taskId, params.taskId),
    orderBy: (inv, { desc }) => [desc(inv.createdAt)],
    columns: { id: true, inviteeEmail: true, role: true, status: true, expiresAt: true, createdAt: true },
  });
}
