/**
 * Status and priority presentation for the tasks page.
 *
 * These lived inline in page.tsx as plain objects that were indexed directly —
 * `priorityConfig[priority].bgColor`. That reads as safe because `Task` types
 * `priority` as a four-value union, but the union is a claim about the API, not
 * a guarantee from it: `tasks.priority` is a nullable varchar with no CHECK
 * constraint, so the column holds whatever a writer put there. Two rows written
 * on 2026-05-13 carry `normal` — a value from the OTHER priority vocabulary
 * this codebase uses (`low|normal|high|urgent` for inbox messages, triggers and
 * task GROUPS, whose column default is literally 'normal'). One of those rows is
 * still in_progress, so it renders on every visit, and the lookup returned
 * undefined and took the whole page down with
 * "Cannot read properties of undefined (reading 'bgColor')".
 *
 * So the resolvers below are total over `string | null | undefined` rather than
 * over the union. An unrecognised value renders in a neutral style showing the
 * raw string: it cannot crash, and it says what the row actually contains
 * instead of quietly relabelling it as something the reader would trust.
 */
import { AlertCircle, ArrowUpCircle, CheckCircle2, Circle, type LucideIcon } from 'lucide-react';

export interface StatusStyle {
  icon: LucideIcon;
  label: string;
  color: string;
  bgColor: string;
  borderColor: string;
  accentColor: string;
  dotColor: string;
}

export interface PriorityStyle {
  label: string;
  color: string;
  bgColor: string;
  borderColor: string;
  dotColor: string;
}

export const statusConfig: Record<string, StatusStyle> = {
  in_progress: {
    icon: ArrowUpCircle,
    label: 'In Progress',
    color: 'text-emerald-700 dark:text-emerald-400',
    bgColor: 'bg-emerald-50 dark:bg-emerald-900/30',
    borderColor: 'border-emerald-200 dark:border-emerald-800',
    accentColor: 'text-emerald-600 dark:text-emerald-400',
    dotColor: 'bg-emerald-500',
  },
  pending: {
    icon: Circle,
    label: 'Pending',
    color: 'text-blue-700 dark:text-blue-400',
    bgColor: 'bg-blue-50 dark:bg-blue-900/30',
    borderColor: 'border-blue-200 dark:border-blue-800',
    accentColor: 'text-blue-600 dark:text-blue-400',
    dotColor: 'bg-blue-500',
  },
  blocked: {
    icon: AlertCircle,
    label: 'Blocked',
    color: 'text-red-700 dark:text-red-400',
    bgColor: 'bg-red-50 dark:bg-red-900/30',
    borderColor: 'border-red-200 dark:border-red-800',
    accentColor: 'text-red-600 dark:text-red-400',
    dotColor: 'bg-red-500',
  },
  completed: {
    icon: CheckCircle2,
    label: 'Completed',
    color: 'text-muted-foreground',
    bgColor: 'bg-muted/50',
    borderColor: 'border-border',
    accentColor: 'text-muted-foreground/70',
    dotColor: 'bg-gray-400',
  },
};

export const priorityConfig: Record<string, PriorityStyle> = {
  critical: {
    label: 'Critical',
    color: 'text-red-700 dark:text-red-400',
    bgColor: 'bg-red-50 dark:bg-red-900/30',
    borderColor: 'border-red-200 dark:border-red-800',
    dotColor: 'bg-red-500',
  },
  high: {
    label: 'High',
    color: 'text-orange-700 dark:text-orange-400',
    bgColor: 'bg-orange-50 dark:bg-orange-900/30',
    borderColor: 'border-orange-200 dark:border-orange-800',
    dotColor: 'bg-orange-500',
  },
  medium: {
    label: 'Medium',
    color: 'text-muted-foreground',
    bgColor: 'bg-muted/50',
    borderColor: 'border-border',
    dotColor: 'bg-gray-400',
  },
  low: {
    label: 'Low',
    color: 'text-slate-500 dark:text-slate-400',
    bgColor: 'bg-slate-50 dark:bg-slate-900/30',
    borderColor: 'border-slate-200 dark:border-slate-800',
    dotColor: 'bg-slate-400',
  },
};

/**
 * The value the API actually applies when a task carries no priority: the
 * column default. A null therefore means "medium", not "unknown".
 */
export const DEFAULT_PRIORITY = 'medium';

/** Shown for a value neither vocabulary accounts for. Deliberately drab. */
const UNKNOWN_STATUS: Omit<StatusStyle, 'label'> = {
  icon: Circle,
  color: 'text-muted-foreground',
  bgColor: 'bg-muted/50',
  borderColor: 'border-border',
  accentColor: 'text-muted-foreground/70',
  dotColor: 'bg-gray-400',
};

const UNKNOWN_PRIORITY: Omit<PriorityStyle, 'label'> = {
  color: 'text-muted-foreground',
  bgColor: 'bg-muted/50',
  borderColor: 'border-border',
  dotColor: 'bg-gray-400',
};

/**
 * A label for a value we do not recognise. The string comes from the database
 * and nothing constrains its length, so it is clamped — a runaway value should
 * cost a truncated badge, not the page layout. React escapes the text itself.
 */
function rawLabel(value: string): string {
  const trimmed = value.trim();
  return trimmed.length > 24 ? `${trimmed.slice(0, 24)}…` : trimmed;
}

export function resolveStatus(status: string | null | undefined): StatusStyle {
  if (!status) return { ...UNKNOWN_STATUS, label: 'Unknown' };
  return statusConfig[status] ?? { ...UNKNOWN_STATUS, label: rawLabel(status) };
}

/**
 * Returns null when the badge should not render at all. Medium is the default
 * every task gets when nobody chose, so badging it says nothing; a missing
 * value means the same thing and is treated the same way.
 */
export function resolvePriority(priority: string | null | undefined): PriorityStyle | null {
  if (!priority || priority === DEFAULT_PRIORITY) return null;
  return priorityConfig[priority] ?? { ...UNKNOWN_PRIORITY, label: rawLabel(priority) };
}
