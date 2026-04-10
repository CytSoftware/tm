"use client";

import { cn } from "@/lib/utils";

/**
 * Deterministic avatar color derived from username hash.
 * Produces a consistent hue per user, similar to Linear's approach.
 */
const AVATAR_COLORS = [
  "bg-red-500",
  "bg-orange-500",
  "bg-amber-500",
  "bg-yellow-500",
  "bg-lime-500",
  "bg-green-500",
  "bg-emerald-500",
  "bg-teal-500",
  "bg-cyan-500",
  "bg-sky-500",
  "bg-blue-500",
  "bg-indigo-500",
  "bg-violet-500",
  "bg-purple-500",
  "bg-fuchsia-500",
  "bg-pink-500",
  "bg-rose-500",
];

function hashString(str: string): number {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = (hash * 31 + str.charCodeAt(i)) | 0;
  }
  return Math.abs(hash);
}

function getInitials(username: string): string {
  return username.slice(0, 2).toUpperCase();
}

function getColor(username: string): string {
  return AVATAR_COLORS[hashString(username) % AVATAR_COLORS.length];
}

type Props = {
  username: string;
  /** Tailwind size class, e.g. "size-6" (default: "size-5") */
  size?: "size-4" | "size-5" | "size-6" | "size-7" | "size-8";
  className?: string;
};

export function UserAvatar({ username, size = "size-5", className }: Props) {
  return (
    <div
      className={cn(
        "rounded-full grid place-items-center text-white font-medium shrink-0",
        size,
        size === "size-4"
          ? "text-[7px]"
          : size === "size-5"
            ? "text-[8px]"
            : size === "size-6"
              ? "text-[9px]"
              : size === "size-7"
                ? "text-[10px]"
                : "text-[11px]",
        getColor(username),
        className,
      )}
      title={username}
    >
      {getInitials(username)}
    </div>
  );
}
