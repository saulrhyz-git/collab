import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/** "2h ago", "3d ago", etc. — for the recent-activity feed. */
export function formatRelativeTime(date: Date | string): string {
  const d = typeof date === "string" ? new Date(date) : date;
  const diffMs = Date.now() - d.getTime();
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;
  if (diffMs < minute) return "just now";
  if (diffMs < hour) return `${Math.floor(diffMs / minute)}m ago`;
  if (diffMs < day) return `${Math.floor(diffMs / hour)}h ago`;
  if (diffMs < 7 * day) return `${Math.floor(diffMs / day)}d ago`;
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/** "Today", "Tomorrow", "Overdue by 2d", or a short date — for due-date labels across the dashboard. */
export function formatDueLabel(date: Date | string): { label: string; overdue: boolean } {
  const d = typeof date === "string" ? new Date(date) : date;
  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const startOfDue = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const dayDiff = Math.round((startOfDue.getTime() - startOfToday.getTime()) / 86_400_000);

  if (dayDiff === 0) return { label: "Due today", overdue: false };
  if (dayDiff === 1) return { label: "Due tomorrow", overdue: false };
  if (dayDiff < 0) return { label: `Overdue ${Math.abs(dayDiff)}d`, overdue: true };
  if (dayDiff <= 6) return { label: `Due in ${dayDiff}d`, overdue: false };
  return { label: d.toLocaleDateString(undefined, { month: "short", day: "numeric" }), overdue: false };
}
