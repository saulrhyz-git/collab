import { resolvePageContext } from "../../../auth/page-context";
import ProjectShell from "./project-shell";

export default async function ProjectPage({ params }: { params: Promise<{ projectId: string }> }) {
  const ctx = await resolvePageContext();
  const { projectId } = await params;

  return (
    <ProjectShell
      projectId={projectId}
      activeWorkspaceId={ctx.activeWorkspaceId}
      userName={ctx.userName}
      isSuperAdmin={ctx.isSuperAdmin}
    />
  );
}
