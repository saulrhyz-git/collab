import { redirect } from "next/navigation";
import { auth } from "../../../auth";
import { isSuperAdmin } from "../../../auth/super-admin";
import CustomRolesShell from "./custom-roles-shell";

export default async function CustomRolesPage() {
  const session = await auth();
  if (!session?.user?.id) redirect("/login");
  if (!(await isSuperAdmin(session.user.id))) redirect("/");

  return <CustomRolesShell />;
}
