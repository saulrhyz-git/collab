import { redirect } from "next/navigation";
import { auth } from "../../../auth";
import { isSuperAdmin } from "../../../auth/super-admin";
import UsersShell from "./users-shell";

export default async function UsersPage() {
  const session = await auth();
  if (!session?.user?.id) redirect("/login");
  if (!(await isSuperAdmin(session.user.id))) redirect("/");

  return <UsersShell />;
}
