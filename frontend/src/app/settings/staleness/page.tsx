import { redirect } from "next/navigation";

export default function LegacyStalenessSettingsPage() {
  redirect("/settings/columns");
}
