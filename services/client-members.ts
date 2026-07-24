/**
 * client_members — direct (non-invite) grants of a CLIENT-scoped custom role
 * on a client, plus the roster read used by the client detail page's
 * "collaborators" panel. Invite-by-email goes through
 * services/client-invitations.ts instead; this file is for a workspace
 * admin/client-creator adding someone who's already a known app user.
 *
 * Mirrors client_members_insert/_delete RLS in db/rls-policies.sql (PART 2):
 * is_workspace_admin(workspace) OR has_workspace_permission(workspace,
 * 'client.manage') OR is_client_creator(client).
 */

import { eq, and } from "drizzle-orm";
import { db } from "../db/client";
import { clientMembers, clients, customRoles, workspaceMembers, users, activityLogs } from "../db/schema";
import { isSuperAdmin } from "../auth/super-admin";
import { userHasWorkspacePermission } from "./permissions";

export class NotAuthorizedError extends Error {}
export class NotFoundError extends Error {}
export class ValidationError extends Error {}

async function getClientOrThrow(clientId: string) {
  const client = await db.query.clients.findFirst({ where: eq(clients.id, clientId) });
  if (!client) throw new NotFoundError("Client not found.");
  return client;
}

async function isWorkspaceAdmin(workspaceId: string, userId: string) {
  if (await isSuperAdmin(userId)) return true;
  const m = await db.query.workspaceMembers.findFirst({
    where: and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.userId, userId)),
  });
  return m?.role === "OWNER" || m?.role === "ADMIN";
}

async function assertCanManageClientMembers(clientId: string, workspaceId: string, createdBy: string, actingUserId: string) {
  if (await isWorkspaceAdmin(workspaceId, actingUserId)) return;
  if (createdBy === actingUserId) return;
  const role = await db.query.workspaceMembers.findFirst({
    where: and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.userId, actingUserId)),
  });
  if (await userHasWorkspacePermission(role?.role, actingUserId, "client.manage")) return;
  throw new NotAuthorizedError("Only the client's creator or a workspace admin can manage its collaborators.");
}

export async function listClientMembers(clientId: string, requestingUserId: string) {
  const client = await getClientOrThrow(clientId);
  const isMember = await db.query.clientMembers.findFirst({
    where: and(eq(clientMembers.clientId, clientId), eq(clientMembers.userId, requestingUserId)),
  });
  if (!isMember && !(await isWorkspaceAdmin(client.workspaceId, requestingUserId)) && client.createdBy !== requestingUserId) {
    throw new NotAuthorizedError("You don't have access to this client's collaborator list.");
  }

  return db
    .select({
      userId: users.id,
      fullName: users.fullName,
      email: users.email,
      customRoleId: customRoles.id,
      customRoleName: customRoles.name,
      createdAt: clientMembers.createdAt,
    })
    .from(clientMembers)
    .innerJoin(users, eq(users.id, clientMembers.userId))
    .innerJoin(customRoles, eq(customRoles.id, clientMembers.customRoleId))
    .where(eq(clientMembers.clientId, clientId));
}

export async function addClientMember(params: {
  clientId: string;
  targetUserId: string;
  customRoleId: string;
  actingUserId: string;
}) {
  const client = await getClientOrThrow(params.clientId);
  await assertCanManageClientMembers(params.clientId, client.workspaceId, client.createdBy, params.actingUserId);

  const role = await db.query.customRoles.findFirst({ where: eq(customRoles.id, params.customRoleId) });
  if (!role) throw new NotFoundError("Custom role not found.");
  if (role.scope !== "CLIENT") {
    throw new ValidationError("Only CLIENT-scoped custom roles can be granted on a client directly.");
  }

  const target = await db.query.users.findFirst({ where: eq(users.id, params.targetUserId) });
  if (!target) throw new NotFoundError("User not found.");

  await db
    .insert(clientMembers)
    .values({
      clientId: params.clientId,
      workspaceId: client.workspaceId,
      userId: params.targetUserId,
      customRoleId: params.customRoleId,
      invitedBy: params.actingUserId,
    })
    .onConflictDoUpdate({
      target: [clientMembers.clientId, clientMembers.userId],
      set: { customRoleId: params.customRoleId },
    });

  await db.insert(activityLogs).values({
    workspaceId: client.workspaceId,
    userId: params.actingUserId,
    action: "client_member.added",
    metadata: { clientId: params.clientId, targetUserId: params.targetUserId, customRoleId: params.customRoleId },
  });
}

export async function removeClientMember(params: { clientId: string; targetUserId: string; actingUserId: string }) {
  const client = await getClientOrThrow(params.clientId);

  if (params.actingUserId !== params.targetUserId) {
    await assertCanManageClientMembers(params.clientId, client.workspaceId, client.createdBy, params.actingUserId);
  }

  await db
    .delete(clientMembers)
    .where(and(eq(clientMembers.clientId, params.clientId), eq(clientMembers.userId, params.targetUserId)));

  await db.insert(activityLogs).values({
    workspaceId: client.workspaceId,
    userId: params.actingUserId,
    action: "client_member.removed",
    metadata: { clientId: params.clientId, targetUserId: params.targetUserId },
  });
}
