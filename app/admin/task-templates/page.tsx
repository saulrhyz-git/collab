import { redirect } from "next/navigation";
import { auth } from "../../../auth";
import { isSuperAdmin } from "../../../auth/super-admin";
import TaskTemplatesShell from "./task-templates-shell";

export default async function TaskTemplatesPage() {
  const session = await auth();
  if (!session?.user?.id) redirect("/login");
  if (!(await isSuperAdmin(session.user.id))) redirect("/");

  return <TaskTemplatesShell />;
}
