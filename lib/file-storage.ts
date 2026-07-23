/**
 * Local-disk, app-controlled file storage for per-engagement uploads
 * (References tab + AI-reviewed documents — see services/project-files.ts).
 * Files live under UPLOADS_DIR (default "./uploads", gitignored), namespaced
 * by workspace/project so a stray path traversal in a filename can't escape
 * its own project's folder. The DB only ever stores the relative
 * storagePath — never an absolute path — so moving the volume (or running
 * in a container with a different mount point) doesn't require a migration.
 */

import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";

const UPLOADS_ROOT = path.resolve(process.env.UPLOADS_DIR || "./uploads");

/** Strips anything that isn't a safe filename character — defense in depth against path traversal via a crafted upload filename. */
function sanitizeFileName(name: string): string {
  const base = path.basename(name).replace(/[^a-zA-Z0-9._-]/g, "_");
  return base.length > 0 ? base.slice(0, 200) : "file";
}

/** Relative path (from UPLOADS_ROOT) where a new upload for this workspace/project should be written — this is what gets stored in project_files.storage_path. */
export function buildStoragePath(workspaceId: string, projectId: string, originalFileName: string): string {
  const safeName = sanitizeFileName(originalFileName);
  return path.join(workspaceId, projectId, `${randomUUID()}-${safeName}`);
}

function resolveOnDisk(storagePath: string): string {
  const resolved = path.resolve(UPLOADS_ROOT, storagePath);
  // Belt-and-suspenders: even though buildStoragePath only ever produces
  // paths under UPLOADS_ROOT, refuse to read/write/delete anything that
  // resolves outside it (e.g. a storage_path value tampered with directly
  // in the DB).
  if (!resolved.startsWith(UPLOADS_ROOT + path.sep) && resolved !== UPLOADS_ROOT) {
    throw new Error("Refusing to access a path outside the uploads root.");
  }
  return resolved;
}

export async function saveFile(storagePath: string, contents: Buffer): Promise<void> {
  const fullPath = resolveOnDisk(storagePath);
  await mkdir(path.dirname(fullPath), { recursive: true });
  await writeFile(fullPath, contents);
}

export async function readStoredFile(storagePath: string): Promise<Buffer> {
  return readFile(resolveOnDisk(storagePath));
}

export async function deleteStoredFile(storagePath: string): Promise<void> {
  try {
    await unlink(resolveOnDisk(storagePath));
  } catch (err: unknown) {
    // Already gone is fine — the DB row is the source of truth we're
    // cleaning up after, not the other way around.
    if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") throw err;
  }
}
