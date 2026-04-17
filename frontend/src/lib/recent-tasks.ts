"use client";

import { useEffect, useState } from "react";

import type { Task } from "./types";

/**
 * "Recent" is a small lightweight snapshot of the tasks the user has opened
 * recently. Used by GlobalSearch to show something useful before the user
 * types. We intentionally store a trimmed subset (not the full Task) so the
 * list stays valid even if the task is later renamed/deleted — a stale entry
 * just shows stale text until the user clicks and the canonical record is
 * refetched by key.
 */

const STORAGE_KEY = "cyt:recent-tasks";
const MAX_RECENT = 7;

export type RecentTask = {
  id: number;
  key: string;
  title: string;
  project_prefix: string | null;
  project_color: string | null;
  priority: Task["priority"];
};

function fromTask(task: Task): RecentTask {
  return {
    id: task.id,
    key: task.key,
    title: task.title,
    project_prefix: task.project_prefix,
    project_color: task.project_color,
    priority: task.priority,
  };
}

function read(): RecentTask[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (r): r is RecentTask =>
        r != null &&
        typeof r.id === "number" &&
        typeof r.key === "string" &&
        typeof r.title === "string",
    );
  } catch {
    return [];
  }
}

function write(list: RecentTask[]): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(list));
  } catch {
    // ignore quota errors
  }
  // Notify listeners in the same tab (storage event only fires cross-tab).
  window.dispatchEvent(new CustomEvent("cyt:recent-tasks-change"));
}

export function recordRecentTask(task: Task): void {
  const entry = fromTask(task);
  const existing = read().filter((r) => r.id !== entry.id);
  write([entry, ...existing].slice(0, MAX_RECENT));
}

export function useRecentTasks(): RecentTask[] {
  const [list, setList] = useState<RecentTask[]>([]);

  useEffect(() => {
    setList(read());
    function handler() {
      setList(read());
    }
    window.addEventListener("cyt:recent-tasks-change", handler);
    window.addEventListener("storage", handler);
    return () => {
      window.removeEventListener("cyt:recent-tasks-change", handler);
      window.removeEventListener("storage", handler);
    };
  }, []);

  return list;
}
