import { redirect } from "next/navigation";

/** Projects moved into Settings; old links keep working. */
export default function LegacyProjectsPage() {
  redirect("/settings/projects");
}
