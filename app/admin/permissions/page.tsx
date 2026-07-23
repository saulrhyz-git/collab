import { redirect } from "next/navigation";
import { auth } from "../../../auth";
import { isSuperAdmin } from "../../../auth/super-admin";
import PermissionsMatrixShell from "./permissions-matrix-shell";

export default async function PermissionsMatrixPage() {
  const session = await auth();
  if (!session?.user?.id) redirect("/login");

  // Belt-and-suspenders with the API route's own check and RLS's
  // is_super_admin() gate on role_permissions writes — a non-superadmin
  // hitting this URL directly gets bounced before any data even loads.
  if (!(await isSuperAdmin(session.user.id))) redirect("/");

  return <PermissionsMatrixShell />;
}
