"use client";

import { UserAvatar } from "@/components/UserAvatar";
import { DeltaIndicator } from "@/components/analytics/DeltaIndicator";
import type { CompletionsPerson } from "@/lib/types";
import { cn } from "@/lib/utils";

function displayName(person: CompletionsPerson): string {
  return person.user_id == null ? "Unassigned" : (person.username ?? "Unknown");
}

/** A semantic, horizontal contribution breakdown. DOM bars keep every name,
 * value, and comparison reachable without relying on SVG hover behavior. */
export function CompletionsChart({ people }: { people: CompletionsPerson[] }) {
  const max = Math.max(1, ...people.map((person) => person.count));

  return (
    <ol className="divide-y divide-border/50" aria-label="Completions by person">
      {people.map((person, index) => {
        const name = displayName(person);
        const width = `${Math.max(3, (person.count / max) * 100)}%`;

        return (
          <li
            key={person.user_id ?? "unassigned"}
            className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-4 gap-y-2 py-3 first:pt-0 last:pb-0 sm:grid-cols-[minmax(150px,0.72fr)_minmax(180px,1.8fr)_auto] sm:items-center sm:gap-x-5"
          >
            <div className="flex min-w-0 items-center gap-2.5">
              <span className="w-5 shrink-0 text-right text-[10px] tabular-nums text-muted-foreground/60">
                {index + 1}
              </span>
              {person.user_id == null ? (
                <span className="size-6 shrink-0 rounded-full bg-muted-foreground/20" />
              ) : (
                <UserAvatar
                  username={person.username ?? "?"}
                  avatarUrl={person.avatar_url ?? undefined}
                  size="size-6"
                />
              )}
              <span
                className={cn(
                  "truncate text-[12px] font-medium",
                  person.user_id == null && "italic text-muted-foreground",
                )}
                title={name}
              >
                {name}
              </span>
            </div>

            <div
              className="order-3 col-span-2 ml-7 h-1.5 overflow-hidden rounded-full bg-muted sm:order-none sm:col-span-1 sm:ml-0"
              role="img"
              aria-label={`${name}: ${person.count} completed`}
            >
              <div
                className={cn(
                  "h-full rounded-full",
                  person.user_id == null
                    ? "bg-muted-foreground/45"
                    : "bg-blue-600 dark:bg-blue-500",
                )}
                style={{ width }}
              />
            </div>

            <div className="flex min-w-[112px] items-baseline justify-end gap-2">
              <span className="text-[15px] font-semibold tabular-nums">
                {person.count.toLocaleString()}
              </span>
              <span className="sr-only">
                completed; {person.prev_count} in the prior week
              </span>
              <DeltaIndicator
                current={person.count}
                previous={person.prev_count}
                className="hidden sm:inline-flex"
              />
            </div>
          </li>
        );
      })}
    </ol>
  );
}
