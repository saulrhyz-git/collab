import { eq, and, isNull, desc } from "drizzle-orm";
import { db } from "../db/client";
import {
  clients,
  clientMembers,
  projects,
  projectMembers,
  projectCustomRoleMembers,
  workspaceMembers,
  activityLogs,
} from "../db/schema";
import { isSuperAdmin } from "../auth/super-admin";
import { userHasWorkspacePermission } from "./permissions";

export class NotAuthorizedError extends Error {}
export class NotFoundError extends Error {}

async function isWorkspaceMember(workspaceId: string, userId: string) {
  if (await isSuperAdmin(userId)) return true;
  const m = await db.query.workspaceMembers.findFirst({
    where: and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.userId, userId)),
  });
  return !!m;
}

/** Structural bypass mirroring RLS's is_workspace_admin() — OWNER/ADMIN role or super admin, retained as an oversight mechanism (see db/rls-policies.sql's PART 2 comment). */
async function isWorkspaceAdmin(workspaceId: string, userId: string) {
  if (await isSuperAdmin(userId)) return true;
  const m = await db.query.workspaceMembers.findFirst({
    where: and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.userId, userId)),
  });
  return m?.role === "OWNER" || m?.role === "ADMIN";
}

function isClientMemberRow(clientId: string, userId: string) {
  return db.query.clientMembers.findFirst({
    where: and(eq(clientMembers.clientId, clientId), eq(clientMembers.userId, userId)),
  });
}

/**
 * Mirrors clients_select in db/rls-policies.sql (PART 2): plain workspace
 * membership no longer implies visibility into a client — the workspace
 * owner/admin, whoever created the record, or an explicit client_members
 * grant are the only paths in.
 */
async function canAccessClient(
  client: { id: string; workspaceId: string; createdBy: string },
  userId: string
): Promise<boolean> {
  if (client.createdBy === userId) return true;
  if (await isWorkspaceAdmin(client.workspaceId, userId)) return true;
  return !!(await isClientMemberRow(client.id, userId));
}

async function getWorkspaceRole(workspaceId: string, userId: string) {
  const m = await db.query.workspaceMembers.findFirst({
    where: and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.userId, userId)),
  });
  return m?.role;
}

/**
 * Matrix-governed ('client.manage') rather than a hardcoded OWNER/ADMIN
 * check — see services/permissions.ts. Kept as a named helper since both
 * updateClient and archiveClient need it.
 */
async function canManageClients(workspaceId: string, userId: string) {
  const role = await getWorkspaceRole(workspaceId, userId);
  return userHasWorkspacePermission(role, userId, "client.manage");
}

/**
 * Creates a client record — "who we're doing the work for." Any workspace
 * member can add one (same latitude as creating a project), matching how a
 * solo practitioner or small team actually works: whoever picks up a new
 * matter/account logs it themselves rather than waiting on an admin.
 */
export async function createClient(params: {
  workspaceId: string;
  createdBy: string;
  name: string;
  primaryContactName?: string;
  primaryContactEmail?: string;
  notes?: string;
}) {
  const name = params.name.trim();
  if (!name) throw new Error("Client name is required.");

  const role = await getWorkspaceRole(params.workspaceId, params.createdBy);
  if (!(await userHasWorkspacePermission(role, params.createdBy, "client.create"))) {
    throw new NotAuthorizedError("You must be a member of this workspace to add a client.");
  }

  const [client] = await db
    .insert(clients)
    .values({
      workspaceId: params.workspaceId,
      name,
      primaryContactName: params.primaryContactName || undefined,
      primaryContactEmail: params.primaryContactEmail || undefined,
      notes: params.notes || undefined,
      createdBy: params.createdBy,
    })
    .returning();

  await db.insert(activityLogs).values({
    workspaceId: params.workspaceId,
    userId: params.createdBy,
    action: "client.created",
    metadata: { clientId: client.id, name },
  });

  return client;
}

/**
 * Non-archived clients in a workspace the caller can actually see, for the
 * "which client is this engagement for" picker and the dashboard's grouped
 * view. Workspace membership alone no longer implies visibility (see
 * canAccessClient) — a workspace admin/owner/super admin sees every client;
 * anyone else only sees clients they created or hold an explicit
 * client_members grant for.
 */
export async function listClientsForWorkspace(workspaceId: string, requestingUserId: string) {
  if (!(await isWorkspaceMember(workspaceId, requestingUserId))) {
    throw new NotAuthorizedError("You are not a member of this workspace.");
  }

  const all = await db.query.clients.findMany({
    where: and(eq(clients.workspaceId, workspaceId), isNull(clients.archivedAt)),
    orderBy: (c, { asc }) => [asc(c.name)],
  });

  if (await isWorkspaceAdmin(workspaceId, requestingUserId)) return all;

  const memberships = await db.query.clientMembers.findMany({
    where: eq(clientMembers.userId, requestingUserId),
    columns: { clientId: true },
  });
  const memberClientIds = new Set(memberships.map((m) => m.clientId));

  return all.filter((c) => c.createdBy === requestingUserId || memberClientIds.has(c.id));
}

/** A client plus every engagement (project) on record for them — the client detail page's single data source. */
export async function getClient(clientId: string, requestingUserId: string) {
  const client = await db.query.clients.findFirst({ where: eq(clients.id, clientId) });
  if (!client) throw new NotFoundError("Client not found.");

  if (!(await canAccessClient(client, requestingUserId))) {
    throw new NotAuthorizedError("You don't have access to this client.");
  }

  const isSuper = await isSuperAdmin(requestingUserId);
  const isAdmin = await isWorkspaceAdmin(client.workspaceId, requestingUserId);
  const allEngagements = await db.query.projects.findMany({
    where: and(eq(projects.clientId, clientId), isNull(projects.archivedAt)),
    orderBy: [desc(projects.createdAt)],
  });

  let engagements = allEngagements;
  if (!isSuper && !isAdmin) {
    // Mirrors can_access_project in db/rls-policies.sql (PART 2):
    // PUBLIC_TO_WORKSPACE no longer grants anything — visibility requires a
    // direct project_members row, a project-scoped custom role, or (since
    // the caller already passed canAccessClient above via a client_members
    // grant) implicit access to every one of this client's engagements.
    const viaClientMembership = await isClientMemberRow(clientId, requestingUserId);
    if (!viaClientMembership) {
      const [memberships, customRoleMemberships] = await Promise.all([
        db.query.projectMembers.findMany({
          where: eq(projectMembers.userId, requestingUserId),
          columns: { projectId: true },
        }),
        db.query.projectCustomRoleMembers.findMany({
          where: eq(projectCustomRoleMembers.userId, requestingUserId),
          columns: { projectId: true },
        }),
      ]);
      const visibleProjectIds = new Set([
        ...memberships.map((m) => m.projectId),
        ...customRoleMemberships.map((m) => m.projectId),
      ]);
      engagements = allEngagements.filter((p) => visibleProjectIds.has(p.id));
    }
  }

  return { ...client, engagements };
}

export async function updateClient(params: {
  clientId: string;
  actingUserId: string;
  name?: string;
  primaryContactName?: string | null;
  primaryContactEmail?: string | null;
  notes?: string | null;
}) {
  const client = await db.query.clients.findFirst({ where: eq(clients.id, params.clientId) });
  if (!client) throw new NotFoundError("Client not found.");

  const canManage = await canManageClients(client.workspaceId, params.actingUserId);
  if (!canManage && client.createdBy !== params.actingUserId) {
    throw new NotAuthorizedError("Only the client's creator or a workspace admin can edit it.");
  }

  const [updated] = await db
    .update(clients)
    .set({
      ...(params.name !== undefined ? { name: params.name.trim() } : {}),
      ...(params.primaryContactName !== undefined ? { primaryContactName: params.primaryContactName } : {}),
      ...(params.primaryContactEmail !== undefined ? { primaryContactEmail: params.primaryContactEmail } : {}),
      ...(params.notes !== undefined ? { notes: params.notes } : {}),
      updatedAt: new Date(),
    })
    .where(eq(clients.id, params.clientId))
    .returning();

  return updated;
}

/** Soft-delete — archives rather than drops, so past engagement history under this client isn't lost. */
export async function archiveClient(clientId: string, actingUserId: string) {
  const client = await db.query.clients.findFirst({ where: eq(clients.id, clientId) });
  if (!client) throw new NotFoundError("Client not found.");

  if (!(await canManageClients(client.workspaceId, actingUserId))) {
    throw new NotAuthorizedError("Only a workspace admin can archive a client.");
  }

  await db.update(clients).set({ archivedAt: new Date() }).where(eq(clients.id, clientId));
  await db.insert(activityLogs).values({
    workspaceId: client.workspaceId,
    userId: actingUserId,
    action: "client.archived",
    metadata: { clientId, name: client.name },
  });
}
