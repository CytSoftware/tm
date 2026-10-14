import { redirect } from "next/navigation";

/** Projects moved into Settings; old links keep working. */
export default async function LegacyProjectPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  redirect(`/settings/projects/${id}`);
}
