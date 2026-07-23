/**
 * Per-engagement file uploads — backs both the References tab (category
 * REFERENCE) and the AI Review tab (category AI_REVIEWED, populated by
 * services/ai-review.ts once a document's been analyzed). Mirrors
 * project_files RLS exactly: read follows plain project visibility;
 * upload requires is_workspace_admin OR 'file.upload'; delete requires
 * being the uploader, is_workspace_admin, or 'file.manage'.
 */

import { eq, and } from "drizzle-orm";
import { db } from "../db/client";
import { projectFiles, projects } from "../db/schema";
import { requireProjectAccess, NotFoundError, NotAuthorizedError } from "./tasks";
import { userHasProjectPermission } from "./permissions";
import { isSuperAdmin } from "../auth/super-admin";
import { buildStoragePath, saveFile, readStoredFile, deleteStoredFile } from "../lib/file-storage";

export { NotFoundError, NotAuthorizedError };

type Category = "REFERENCE" | "AI_REVIEWED";

const MAX_FILE_SIZE_BYTES = 25 * 1024 * 1024; // 25MB — comfortably covers contracts/MOAs as PDF or Word docs

async function isWorkspaceAdminRole(workspaceId: string, userId: string) {
  if (await isSuperAdmin(userId)) return true;
  const m = await db.query.workspaceMembers.findFirst({
    where: (wm, { eq: eqOp, and: andOp }) => andOp(eqOp(wm.workspaceId, workspaceId), eqOp(wm.userId, userId)),
  });
  return m?.role === "OWNER" || m?.role === "ADMIN";
}

async function getProjectOrThrow(projectId: string) {
  const project = await db.query.projects.findFirst({ where: eq(projects.id, projectId) });
  if (!project) throw new NotFoundError("Project not found.");
  return project;
}

async function assertCanUpload(projectId: string, workspaceId: string, actingUserId: string) {
  const role = await requireProjectAccess(projectId, workspaceId, actingUserId);
  if (await isWorkspaceAdminRole(workspaceId, actingUserId)) return;
  if (await userHasProjectPermission(role, actingUserId, "file.upload")) return;
  throw new NotAuthorizedError("You don't have permission to upload files to this engagement.");
}

async function assertCanManageFiles(projectId: string, workspaceId: string, actingUserId: string) {
  const role = await requireProjectAccess(projectId, workspaceId, actingUserId);
  if (await isWorkspaceAdminRole(workspaceId, actingUserId)) return;
  if (await userHasProjectPermission(role, actingUserId, "file.manage")) return;
  throw new NotAuthorizedError("You don't have permission to manage files on this engagement.");
}

export async function listProjectFiles(params: { projectId: string; userId: string; category?: Category }) {
  const project = await getProjectOrThrow(params.projectId);
  await requireProjectAccess(params.projectId, project.workspaceId, params.userId);

  return db.query.projectFiles.findMany({
    where: params.category
      ? and(eq(projectFiles.projectId, params.projectId), eq(projectFiles.category, params.category))
      : eq(projectFiles.projectId, params.projectId),
    orderBy: (f, { desc }) => [desc(f.createdAt)],
    with: { uploader: { columns: { id: true, fullName: true, avatarUrl: true } } },
  });
}

export async function uploadProjectFile(params: {
  projectId: string;
  actingUserId: string;
  fileName: string;
  mimeType: string;
  contents: Buffer;
  category?: Category;
}) {
  if (params.contents.byteLength === 0) throw new Error("The uploaded file is empty.");
  if (params.contents.byteLength > MAX_FILE_SIZE_BYTES) {
    throw new Error("Files larger than 25MB aren't supported.");
  }

  const project = await getProjectOrThrow(params.projectId);
  await assertCanUpload(params.projectId, project.workspaceId, params.actingUserId);

  const storagePath = buildStoragePath(project.workspaceId, params.projectId, params.fileName);
  await saveFile(storagePath, params.contents);

  const [file] = await db
    .insert(projectFiles)
    .values({
      projectId: params.projectId,
      workspaceId: project.workspaceId,
      fileName: params.fileName,
      mimeType: params.mimeType,
      sizeBytes: params.contents.byteLength,
      storagePath,
      category: params.category ?? "REFERENCE",
      uploadedBy: params.actingUserId,
    })
    .returning();

  return file;
}

export async function getProjectFileForDownload(fileId: string, userId: string) {
  const file = await db.query.projectFiles.findFirst({ where: eq(projectFiles.id, fileId) });
  if (!file) throw new NotFoundError("File not found.");

  const project = await getProjectOrThrow(file.projectId);
  await requireProjectAccess(file.projectId, project.workspaceId, userId);

  const contents = await readStoredFile(file.storagePath);
  return { file, contents };
}

export async function deleteProjectFile(fileId: string, actingUserId: string) {
  const file = await db.query.projectFiles.findFirst({ where: eq(projectFiles.id, fileId) });
  if (!file) throw new NotFoundError("File not found.");

  if (file.uploadedBy !== actingUserId) {
    await assertCanManageFiles(file.projectId, file.workspaceId, actingUserId);
  } else {
    // Still needs at least read access to the project — a removed member
    // shouldn't be able to delete a file via a stale reference.
    await requireProjectAccess(file.projectId, file.workspaceId, actingUserId);
  }

  await db.delete(projectFiles).where(eq(projectFiles.id, fileId));
  await deleteStoredFile(file.storagePath);
}

/**
 * The "Add to References" button on the AI Review tab — flips a
 * previously AI-reviewed document over to the References tab. Same
 * permission bar as uploading (not a separate "publish" permission), since
 * this is really just deciding a document belongs in the shared reference
 * set.
 */
export async function promoteFileToReferences(fileId: string, actingUserId: string) {
  const file = await db.query.projectFiles.findFirst({ where: eq(projectFiles.id, fileId) });
  if (!file) throw new NotFoundError("File not found.");

  await assertCanUpload(file.projectId, file.workspaceId, actingUserId);

  const [updated] = await db
    .update(projectFiles)
    .set({ category: "REFERENCE" })
    .where(eq(projectFiles.id, fileId))
    .returning();

  return updated;
}
