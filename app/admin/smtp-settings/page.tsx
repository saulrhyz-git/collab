import { redirect } from "next/navigation";
import { auth } from "../../../auth";
import { isSuperAdmin } from "../../../auth/super-admin";
import SmtpSettingsShell from "./smtp-settings-shell";

export default async function SmtpSettingsPage() {
  const session = await auth();
  if (!session?.user?.id) redirect("/login");
  if (!(await isSuperAdmin(session.user.id))) redirect("/");

  return <SmtpSettingsShell />;
}
