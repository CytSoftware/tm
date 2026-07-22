import { redirect } from "next/navigation";

export default function LegacyWebhookSettingsPage() {
  redirect("/settings/outgoing-webhooks");
}
