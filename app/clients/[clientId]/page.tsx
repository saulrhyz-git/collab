import { redirect } from "next/navigation";
import { auth } from "../../../auth";
import ClientShell from "./client-shell";

export default async function ClientPage({ params }: { params: Promise<{ clientId: string }> }) {
  const session = await auth();
  if (!session?.user?.id) redirect("/login");

  const { clientId } = await params;
  return <ClientShell clientId={clientId} />;
}
