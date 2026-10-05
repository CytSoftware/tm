/**
 * Global subscriber for the CRM.
 *
 * One socket per mounted /crm view, on the `crm` group (contacts, deals,
 * touchpoints, pipelines, follow-up changes made through the CRM). Events are
 * tiny; every one just invalidates the whole ["crm"] namespace. Meeting
 * events matter too — a new recording moves a contact's "last contact" — so
 * the page also mounts the meetings socket.
 */

import type { QueryClient } from "@tanstack/react-query";

import { connectGroupSocket } from "@/lib/group-ws";

export function connectCrmSocket(queryClient: QueryClient): () => void {
  return connectGroupSocket(queryClient, "/ws/crm/", ["crm"]);
}
