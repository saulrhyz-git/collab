import { resolvePageContext } from "../auth/page-context";
import DashboardShell from "./dashboard-shell";

export default async function HomePage() {
  const ctx = await resolvePageContext();

  return (
    <DashboardShell
      activeWorkspaceId={ctx.activeWorkspaceId}
      userName={ctx.userName}
      isSuperAdmin={ctx.isSuperAdmin}
    />
  );
}
