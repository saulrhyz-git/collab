import { eq } from "drizzle-orm";
import { db } from "../db/client";
import { tasks, taskDependencies } from "../db/schema";
import { requireProjectAccess, canPerform, NotFoundError, NotAuthorizedError } from "./tasks";

export { NotFoundError, NotAuthorizedError };
export class CyclicDependencyError extends Error {}

type DependencyType = "FINISH_TO_START" | "START_TO_START" | "FINISH_TO_FINISH" | "START_TO_FINISH";

/**
 * Detects whether adding predecessor -> successor would create a cycle by
 * walking the existing graph from `successor` forward. Small graphs (a
 * single project's tasks), so a plain BFS is plenty — no need for a
 * recursive CTE in Postgres.
 */
async function wouldCreateCycle(projectId: string, predecessorTaskId: string, successorTaskId: string): Promise<boolean> {
  if (predecessorTaskId === successorTaskId) return true;

  const allDeps = await db
    .select({ predecessorTaskId: taskDependencies.predecessorTaskId, successorTaskId: taskDependencies.successorTaskId })
    .from(taskDependencies)
    .innerJoin(tasks, eq(tasks.id, taskDependencies.successorTaskId))
    .where(eq(tasks.projectId, projectId));

  const adjacency = new Map<string, string[]>();
  for (const dep of allDeps) {
    if (!adjacency.has(dep.predecessorTaskId)) adjacency.set(dep.predecessorTaskId, []);
    adjacency.get(dep.predecessorTaskId)!.push(dep.successorTaskId);
  }

  // Would the new edge let us walk from successorTaskId back to predecessorTaskId?
  const queue = [successorTaskId];
  const seen = new Set<string>();
  while (queue.length) {
    const current = queue.shift()!;
    if (current === predecessorTaskId) return true;
    if (seen.has(current)) continue;
    seen.add(current);
    queue.push(...(adjacency.get(current) ?? []));
  }
  return false;
}

export async function addDependency(params: {
  predecessorTaskId: string;
  successorTaskId: string;
  type?: DependencyType;
  actingUserId: string;
}) {
  const successor = await db.query.tasks.findFirst({ where: eq(tasks.id, params.successorTaskId) });
  if (!successor) throw new NotFoundError("Task not found.");
  const predecessor = await db.query.tasks.findFirst({ where: eq(tasks.id, params.predecessorTaskId) });
  if (!predecessor) throw new NotFoundError("Predecessor task not found.");
  if (predecessor.projectId !== successor.projectId) {
    throw new NotAuthorizedError("Both tasks must be in the same project.");
  }

  if (!(await canPerform(params.actingUserId, successor.projectId, "tasks.edit"))) {
    throw new NotAuthorizedError("You don't have permission to add dependencies in this engagement.");
  }

  if (await wouldCreateCycle(successor.projectId, params.predecessorTaskId, params.successorTaskId)) {
    throw new CyclicDependencyError("This would create a circular dependency.");
  }

  const [dep] = await db
    .insert(taskDependencies)
    .values({
      predecessorTaskId: params.predecessorTaskId,
      successorTaskId: params.successorTaskId,
      type: params.type ?? "FINISH_TO_START",
    })
    .onConflictDoNothing()
    .returning();

  return dep;
}

export async function removeDependency(params: { dependencyId: string; actingUserId: string }) {
  const dep = await db.query.taskDependencies.findFirst({ where: eq(taskDependencies.id, params.dependencyId) });
  if (!dep) throw new NotFoundError("Dependency not found.");

  const successor = await db.query.tasks.findFirst({ where: eq(tasks.id, dep.successorTaskId) });
  if (!successor) throw new NotFoundError("Task not found.");

  if (!(await canPerform(params.actingUserId, successor.projectId, "tasks.edit"))) {
    throw new NotAuthorizedError("You don't have permission to remove dependencies in this engagement.");
  }

  await db.delete(taskDependencies).where(eq(taskDependencies.id, params.dependencyId));
}
