import {
  BarChart3,
  Bell,
  BookOpen,
  FolderKanban,
  Home,
  LayoutDashboard,
  Link,
  ListTodo,
  Star,
  UserRound,
  Zap,
} from "lucide-react";

import type { QuickActionIcon as QuickActionIconName } from "@/lib/types";

export const QUICK_ACTION_ICON_OPTIONS: {
  value: QuickActionIconName;
  label: string;
}[] = [
  { value: "bolt", label: "Bolt" },
  { value: "board", label: "Board" },
  { value: "project", label: "Project" },
  { value: "user", label: "Person" },
  { value: "tasks", label: "Tasks" },
  { value: "home", label: "Home" },
  { value: "star", label: "Star" },
  { value: "chart", label: "Chart" },
  { value: "book", label: "Book" },
  { value: "bell", label: "Bell" },
  { value: "link", label: "Link" },
];

const ICONS = {
  bell: Bell,
  board: LayoutDashboard,
  book: BookOpen,
  bolt: Zap,
  chart: BarChart3,
  home: Home,
  link: Link,
  project: FolderKanban,
  star: Star,
  tasks: ListTodo,
  user: UserRound,
} satisfies Record<QuickActionIconName, typeof Zap>;

export function QuickActionIcon({
  name,
  className,
}: {
  name: QuickActionIconName;
  className?: string;
}) {
  const Icon = ICONS[name] ?? Link;
  return <Icon className={className} />;
}
