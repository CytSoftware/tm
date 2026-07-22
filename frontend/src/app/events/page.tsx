import { redirect } from "next/navigation";

export default function LegacyEventsPage() {
  redirect("/settings/incoming-webhooks");
}
