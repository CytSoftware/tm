import { redirect } from "next/navigation";

export default function LegacyMonitoringSettingsPage() {
  redirect("/settings/incoming-webhooks");
}
