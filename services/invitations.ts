/**
 * Project invitation service.
 *
 * Security properties:
 * - The raw invite token is only ever emitted once, inside the email link.
 *   The DB stores only sha256(token), so a leaked DB dump can't be used to
 *   forge acceptances.
 * - sendProjectInvite requires the caller to already be a workspace admin
 *   OR a PROJECT_ADMIN/EDITOR on the target project — enforced by the RLS
 *   INSERT policy on project_invitations, and re-checked in-app for a
 *   clean error message before hitting the DB.
 * - acceptProjectInvite is idempotent against replay: a second call with
 *   the same token after acceptance returns a clear "already accepted"
 *   error rather than silently re-granting (which matters if role was
 *   since downgraded).
 */

import { randomBytes, createHash } from "crypto";
import { eq, and } from "drizzle-orm";
import { db } from "../db/client";
import {
  projectInvitations,
  projectMembers,
  workspaceMembers,
  projects,
  users,
  activityLogs,
} from "../db/schema";
import { sendInviteEmail, sendInAppNotification } from "./notifications";
import { isSuperAdmin } from "../auth/super-admin";

const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

export class NotAuthorizedError extends Error {}
export class InvalidInviteError extends Error {}
export class InviteAlreadyResolvedError extends Error {}
export class InviteExpiredError extends Error {}

type ProjectRole = "PROJECT_ADMIN" | "EDITOR" | "VIEWER";

function hashToken(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

async function assertCanInvite(projectId: string, inviterId: string) {
  const project = await db.query.projects.findFirst({ where: eq(projects.id, projectId) });
  if (!project) throw new InvalidInviteError("Project not found.");

  if (await isSuperAdmin(inviterId)) return project;

  const workspaceMembership = await db.query.workspaceMembers.findFirst({
    where: and(eq(workspaceMembers.workspaceId, project.workspaceId), eq(workspaceMembers.userId, inviterId)),
  });
  const isWorkspaceAdmin = workspaceMembership?.role === "OWNER" || workspaceMembership?.role === "ADMIN";

  const projectMembership = await db.query.projectMembers.findFirst({
    where: and(eq(projectMembers.projectId, projectId), eq(projectMembers.userId, inviterId)),
  });
  const isProjectAdminOrEditor =
    projectMembership?.role === "PROJECT_ADMIN" || projectMembership?.role === "EDITOR";

  if (!isWorkspaceAdmin && !isProjectAdminOrEditor) {
    throw new NotAuthorizedError("You don't have permission to invite people to this project.");
  }

  return project;
}

/**
 * Step 3.1 — sendProjectInvite
 */
export async function sendProjectInvite(params: {
  projectId: string;
  inviterId: string;
  targetEmail: string;
  role: ProjectRole;
}) {
  const { projectId, inviterId, role } = params;
  const targetEmail = params.targetEmail.trim().toLowerCase();

  const project = await assertCanInvite(projectId, inviterId);

  const existingUser = await db.query.users.findFirst({ where: eq(users.email, targetEmail) });

  // Guard against duplicate pending invites for the same project+email.
  const existingPending = await db.query.projectInvitations.findFirst({
    where: and(
      eq(projectInvitations.projectId, projectId),
      eq(projectInvitations.inviteeEmail, targetEmail),
      eq(projectInvitations.status, "PENDING")
    ),
  });
  if (existingPending) {
    throw new InvalidInviteError("An invitation is already pending for this email.");
  }

  // If they're already a project member, short-circuit instead of re-inviting.
  if (existingUser) {
    const alreadyMember = await db.query.projectMembers.findFirst({
      where: and(eq(projectMembers.projectId, projectId), eq(projectMembers.userId, existingUser.id)),
    });
    if (alreadyMember) {
      throw new InvalidInviteError("This user is already a member of the project.");
    }
  }

  const rawToken = randomBytes(32).toString("hex");
  const tokenHash = hashToken(rawToken);
  const expiresAt = new Date(Date.now() + INVITE_TTL_MS);

  const [invite] = await db
    .insert(projectInvitations)
    .values({
      projectId,
      workspaceId: project.workspaceId,
      inviterId,
      inviteeEmail: targetEmail,
      inviteeUserId: existingUser?.id ?? null,
      role,
      token: tokenHash,
      status: "PENDING",
      expiresAt,
    })
    .returning();

  await db.insert(activityLogs).values({
    workspaceId: project.workspaceId,
    projectId,
    userId: inviterId,
    action: "invite.sent",
    metadata: { inviteId: invite.id, targetEmail, role },
  });

  if (existingUser) {
    // Existing app user: in-app notification is the primary channel; the
    // email is a courtesy nudge, not the only way to discover the invite.
    await sendInAppNotification({
      userId: existingUser.id,
      type: "PROJECT_INVITE",
      payload: { inviteId: invite.id, projectId, role },
    });
    await sendInviteEmail({
      to: targetEmail,
      rawToken,
      projectId,
      isExistingUser: true,
    });
  } else {
    // No account yet: email with a signup+accept combined link is the only channel.
    await sendInviteEmail({
      to: targetEmail,
      rawToken,
      projectId,
      isExistingUser: false,
    });
  }

  return { inviteId: invite.id, expiresAt };
}

/**
 * Step 3.2 — acceptProjectInvite
 *
 * Accepts either a raw token (email-link flow) or an invite id + the
 * currently authenticated user (in-app notification flow) — the id path
 * still requires the invite's invitee_user_id to match acceptingUserId so
 * a guessed id can't be used to hijack someone else's invite.
 */
export async function acceptProjectInvite(params: {
  inviteTokenOrId: string;
  acceptingUserId: string;
  lookupBy: "token" | "id";
}) {
  const { inviteTokenOrId, acceptingUserId, lookupBy } = params;

  const invite =
    lookupBy === "token"
      ? await db.query.projectInvitations.findFirst({
          where: eq(projectInvitations.token, hashToken(inviteTokenOrId)),
        })
      : await db.query.projectInvitations.findFirst({
          where: eq(projectInvitations.id, inviteTokenOrId),
        });

  if (!invite) throw new InvalidInviteError("Invitation not found.");

  if (lookupBy === "id" && invite.inviteeUserId && invite.inviteeUserId !== acceptingUserId) {
    throw new NotAuthorizedError("This invitation was not addressed to you.");
  }

  if (invite.status !== "PENDING") {
    throw new InviteAlreadyResolvedError(`Invitation already ${invite.status.toLowerCase()}.`);
  }

  if (invite.expiresAt.getTime() < Date.now()) {
    await db
      .update(projectInvitations)
      .set({ status: "EXPIRED" })
      .where(eq(projectInvitations.id, invite.id));
    throw new InviteExpiredError("This invitation has expired.");
  }

  // Sanity check: the accepting user's verified email must match the
  // invitee_email on file (prevents a different logged-in user from
  // consuming an invite meant for someone else's inbox, even if they
  // somehow obtained the raw token).
  const acceptingUser = await db.query.users.findFirst({ where: eq(users.id, acceptingUserId) });
  if (!acceptingUser || acceptingUser.email.toLowerCase() !== invite.inviteeEmail.toLowerCase()) {
    throw new NotAuthorizedError("This invitation was issued to a different email address.");
  }

  await db.transaction(async (tx) => {
    // 1. Grant project-level access.
    await tx
      .insert(projectMembers)
      .values({ projectId: invite.projectId, userId: acceptingUserId, role: invite.role })
      .onConflictDoUpdate({
        target: [projectMembers.projectId, projectMembers.userId],
        set: { role: invite.role },
      });

    // 2. Ensure a workspace_members row exists so the FK/RLS chain resolves,
    //    but scope it to this project only if the user isn't already a
    //    full workspace member — they should NOT gain visibility into
    //    other projects in the workspace as a side effect.
    const existingWorkspaceMembership = await tx.query.workspaceMembers.findFirst({
      where: and(
        eq(workspaceMembers.workspaceId, invite.workspaceId),
        eq(workspaceMembers.userId, acceptingUserId)
      ),
    });

    if (!existingWorkspaceMembership) {
      await tx.insert(workspaceMembers).values({
        workspaceId: invite.workspaceId,
        userId: acceptingUserId,
        role: "GUEST",
        isProjectScopedGuest: invite.projectId, // scopes visibility — see can_access_project()
      });
    }

    // 3. Close out the invitation.
    await tx
      .update(projectInvitations)
      .set({ status: "ACCEPTED", acceptedAt: new Date(), inviteeUserId: acceptingUserId })
      .where(eq(projectInvitations.id, invite.id));

    await tx.insert(activityLogs).values({
      workspaceId: invite.workspaceId,
      projectId: invite.projectId,
      userId: acceptingUserId,
      action: "invite.accepted",
      metadata: { inviteId: invite.id, role: invite.role },
    });
  });

  return { projectId: invite.projectId, workspaceId: invite.workspaceId, role: invite.role };
}

/**
 * Revocation — see Step 5 for the full edge-case writeup. Only the
 * original inviter or a workspace admin may revoke, and only while PENDING.
 */
export async function revokeProjectInvite(params: { inviteId: string; actingUserId: string }) {
  const invite = await db.query.projectInvitations.findFirst({
    where: eq(projectInvitations.id, params.inviteId),
  });
  if (!invite) throw new InvalidInviteError("Invitation not found.");
  if (invite.status !== "PENDING") {
    throw new InviteAlreadyResolvedError(`Cannot revoke — invitation is already ${invite.status.toLowerCase()}.`);
  }

  const workspaceMembership = await db.query.workspaceMembers.findFirst({
    where: and(
      eq(workspaceMembers.workspaceId, invite.workspaceId),
      eq(workspaceMembers.userId, params.actingUserId)
    ),
  });
  const isWorkspaceAdmin = workspaceMembership?.role === "OWNER" || workspaceMembership?.role === "ADMIN";

  if (invite.inviterId !== params.actingUserId && !isWorkspaceAdmin && !(await isSuperAdmin(params.actingUserId))) {
    throw new NotAuthorizedError("Only the inviter or a workspace admin can revoke this invitation.");
  }

  await db
    .update(projectInvitations)
    .set({ status: "REVOKED", revokedAt: new Date() })
    .where(eq(projectInvitations.id, invite.id));

  await db.insert(activityLogs).values({
    workspaceId: invite.workspaceId,
    projectId: invite.projectId,
    userId: params.actingUserId,
    action: "invite.revoked",
    metadata: { inviteId: invite.id },
  });
}

/**
 * Lists invitations for a project, optionally filtered by status. Only a
 * workspace admin or a project admin/editor may view the list — the same
 * bar as sending one, since the list surfaces invitee email addresses.
 */
export async function listProjectInvitations(params: {
  projectId: string;
  requestingUserId: string;
  status?: "PENDING" | "ACCEPTED" | "DECLINED" | "EXPIRED" | "REVOKED";
}) {
  const project = await db.query.projects.findFirst({ where: eq(projects.id, params.projectId) });
  if (!project) throw new InvalidInviteError("Project not found.");

  if (!(await isSuperAdmin(params.requestingUserId))) {
    const workspaceMembership = await db.query.workspaceMembers.findFirst({
      where: and(
        eq(workspaceMembers.workspaceId, project.workspaceId),
        eq(workspaceMembers.userId, params.requestingUserId)
      ),
    });
    const isWorkspaceAdmin = workspaceMembership?.role === "OWNER" || workspaceMembership?.role === "ADMIN";

    const projectMembership = await db.query.projectMembers.findFirst({
      where: and(eq(projectMembers.projectId, params.projectId), eq(projectMembers.userId, params.requestingUserId)),
    });
    const isProjectAdminOrEditor =
      projectMembership?.role === "PROJECT_ADMIN" || projectMembership?.role === "EDITOR";

    if (!isWorkspaceAdmin && !isProjectAdminOrEditor) {
      throw new NotAuthorizedError("You don't have permission to view this project's invitations.");
    }
  }

  return db.query.projectInvitations.findMany({
    where: params.status
      ? and(eq(projectInvitations.projectId, params.projectId), eq(projectInvitations.status, params.status))
      : eq(projectInvitations.projectId, params.projectId),
    orderBy: (inv, { desc }) => [desc(inv.createdAt)],
    columns: {
      id: true,
      inviteeEmail: true,
      role: true,
      status: true,
      expiresAt: true,
      createdAt: true,
    },
  });
}
