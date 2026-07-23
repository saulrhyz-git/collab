/**
 * Turns an activity_logs row (action + metadata) into a human-readable
 * sentence for the dashboard's recent-activity feed. Kept as one lookup
 * table so every action type services/*.ts writes has a matching sentence
 * here — see the `action: "..."` grep across services/ for the full set.
 */
export function formatActivity(
  action: string,
  metadata: Record<string, unknown>,
  actorName: string,
  projectName: string | null
): string {
  const m = metadata ?? {};
  const proj = projectName ? ` in ${projectName}` : "";

  switch (action) {
    case "workspace.created":
      return `${actorName} created this workspace`;
    case "project.created":
      return `${actorName} created the project "${m.name ?? projectName ?? ""}"`;
    case "project.archived":
      return `${actorName} archived ${projectName ?? "a project"}`;
    case "client.created":
      return `${actorName} added a new client: ${m.name ?? ""}`;
    case "client.archived":
      return `${actorName} archived the client ${m.name ?? ""}`;
    case "task.created":
      return `${actorName} created "${m.title ?? "a task"}"${proj}`;
    case "task.status_changed":
      return `${actorName} moved "${m.taskId ? "" : ""}${proj ? "a task" + proj : "a task"}" from ${String(
        m.from ?? "?"
      ).toLowerCase()} to ${String(m.to ?? "?").toLowerCase()}`;
    case "task.updated":
      return `${actorName} updated a task${proj}`;
    case "task.commented":
      return `${actorName} commented on a task${proj}`;
    case "invite.sent":
      return `${actorName} invited ${m.targetEmail ?? "someone"}${proj}`;
    case "invite.accepted":
      return `${actorName} accepted an invitation${proj}`;
    case "invite.revoked":
      return `${actorName} revoked an invitation${proj}`;
    case "project_member.role_changed":
      return `${actorName} changed a member's role${proj}`;
    case "project_member.removed":
      return `${actorName} removed a member${proj}`;
    case "workspace_member.removed":
      return `${actorName} removed a workspace member`;
    default:
      return `${actorName} — ${action}`;
  }
}
