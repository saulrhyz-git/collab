import { resolvePageContext } from "../../../auth/page-context";
import ClientShell from "./client-shell";

export default async function ClientPage({ params }: { params: Promise<{ clientId: string }> }) {
  const ctx = await resolvePageContext();
  const { clientId } = await params;

  return (
    <ClientShell
      clientId={clientId}
      activeWorkspaceId={ctx.activeWorkspaceId}
      userName={ctx.userName}
      isSuperAdmin={ctx.isSuperAdmin}
    />
  );
}
