import { eq, and, isNull, desc } from "drizzle-orm";
import { db } from "../db/client";
import { clients, projects, projectMembers, workspaceMembers, activityLogs } from "../db/schema";
import { isSuperAdmin } from "../auth/super-admin";

export class NotAuthorizedError extends Error {}
export class NotFoundError extends Error {}

async function isWorkspaceMember(workspaceId: string, userId: string) {
  if (await isSuperAdmin(userId)) return true;
  const m = await db.query.workspaceMembers.findFirst({
    where: and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.userId, userId)),
  });
  return !!m;
}

async function isWorkspaceAdmin(workspaceId: string, userId: string) {
  if (await isSuperAdmin(userId)) return true;
  const m = await db.query.workspaceMembers.findFirst({
    where: and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.userId, userId)),
  });
  return m?.role === "OWNER" || m?.role === "ADMIN";
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

  if (!(await isWorkspaceMember(params.workspaceId, params.createdBy))) {
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

/** Non-archived clients in a workspace, for the "which client is this engagement for" picker and the dashboard's grouped view. */
export async function listClientsForWorkspace(workspaceId: string, requestingUserId: string) {
  if (!(await isWorkspaceMember(workspaceId, requestingUserId))) {
    throw new NotAuthorizedError("You are not a member of this workspace.");
  }

  return db.query.clients.findMany({
    where: and(eq(clients.workspaceId, workspaceId), isNull(clients.archivedAt)),
    orderBy: (c, { asc }) => [asc(c.name)],
  });
}

/** A client plus every engagement (project) on record for them — the client detail page's single data source. */
export async function getClient(clientId: string, requestingUserId: string) {
  const client = await db.query.clients.findFirst({ where: eq(clients.id, clientId) });
  if (!client) throw new NotFoundError("Client not found.");

  if (!(await isWorkspaceMember(client.workspaceId, requestingUserId))) {
    throw new NotAuthorizedError("You don't have access to this client.");
  }

  const isSuper = await isSuperAdmin(requestingUserId);
  const allEngagements = await db.query.projects.findMany({
    where: and(eq(projects.clientId, clientId), isNull(projects.archivedAt)),
    orderBy: [desc(projects.createdAt)],
  });

  let engagements = allEngagements;
  if (!isSuper) {
    // Same visibility rule as listProjectsForWorkspace: a PUBLIC_TO_WORKSPACE
    // engagement shows for any workspace member; a PRIVATE_TO_MEMBERS one
    // only if the caller has an explicit project_members row.
    const memberships = await db.query.projectMembers.findMany({
      where: eq(projectMembers.userId, requestingUserId),
      columns: { projectId: true },
    });
    const memberProjectIds = new Set(memberships.map((m) => m.projectId));
    engagements = allEngagements.filter(
      (p) => p.visibility === "PUBLIC_TO_WORKSPACE" || memberProjectIds.has(p.id)
    );
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

  const isAdmin = await isWorkspaceAdmin(client.workspaceId, params.actingUserId);
  if (!isAdmin && client.createdBy !== params.actingUserId) {
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

  if (!(await isWorkspaceAdmin(client.workspaceId, actingUserId))) {
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
