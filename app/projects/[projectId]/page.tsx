import { redirect } from "next/navigation";
import { auth } from "../../../auth";
import ProjectShell from "./project-shell";

export default async function ProjectPage({ params }: { params: Promise<{ projectId: string }> }) {
  const session = await auth();
  if (!session?.user?.id) redirect("/login");

  const { projectId } = await params;
  return <ProjectShell projectId={projectId} />;
}
