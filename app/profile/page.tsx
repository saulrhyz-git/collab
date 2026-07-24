import AppSidebar from "@/components/AppSidebar";
import { resolvePageContext } from "../../auth/page-context";
import ProfileShell from "./profile-shell";

export default async function ProfilePage() {
  const ctx = await resolvePageContext();

  return (
    <div className="flex min-h-screen">
      <AppSidebar activeWorkspaceId={ctx.activeWorkspaceId} userName={ctx.userName} isSuperAdmin={ctx.isSuperAdmin} />
      <div className="flex-1">
        <ProfileShell />
      </div>
    </div>
  );
}
