import type { ReactNode } from "react";

interface StatCardProps {
  title: string;
  value: string | number;
  subtitle?: string;
  icon: ReactNode;
  trend?: { value: number; label: string };
  color?: "violet" | "green" | "amber" | "red" | "blue" | "cyan";
  pulse?: boolean;
}

const colorMap = {
  violet: {
    icon: "bg-primary/15 text-primary",
    text: "text-primary",
    border: "border-primary/20",
  },
  green: {
    icon: "bg-emerald-500/15 text-emerald-400",
    text: "text-emerald-300",
    border: "border-emerald-500/20",
  },
  amber: {
    icon: "bg-amber-500/15 text-amber-400",
    text: "text-amber-300",
    border: "border-amber-500/20",
  },
  red: {
    icon: "bg-red-500/15 text-red-400",
    text: "text-red-300",
    border: "border-red-500/20",
  },
  blue: {
    icon: "bg-blue-500/15 text-blue-400",
    text: "text-blue-300",
    border: "border-blue-500/20",
  },
  cyan: {
    icon: "bg-cyan-500/15 text-cyan-400",
    text: "text-cyan-300",
    border: "border-cyan-500/20",
  },
};

export function StatCard({
  title,
  value,
  subtitle,
  icon,
  trend,
  color = "violet",
  pulse,
}: StatCardProps) {
  const c = colorMap[color];
  return (
    <div
      className={`relative overflow-hidden rounded-2xl border ${c.border} bg-card/60 p-5 transition-colors hover:border-opacity-60`}
    >
      <div className="flex items-start justify-between">
        <div className="min-w-0 flex-1">
          <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
            {title}
          </p>
          <p className="mt-1.5 text-3xl font-bold text-foreground tabular-nums">
            {typeof value === "number" ? value.toLocaleString() : value}
          </p>
          {subtitle && <p className="mt-1 text-xs text-muted-foreground truncate">{subtitle}</p>}
          {trend && (
            <p
              className={`mt-2 text-xs font-medium ${trend.value >= 0 ? "text-emerald-400" : "text-red-400"}`}
            >
              {trend.value >= 0 ? "↑" : "↓"} {Math.abs(trend.value)}% {trend.label}
            </p>
          )}
        </div>
        <div
          className={`shrink-0 ml-3 flex h-11 w-11 items-center justify-center rounded-xl ${c.icon}`}
        >
          {pulse && (
            <span className="absolute inline-flex h-3 w-3">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-current opacity-40" />
              <span className="relative inline-flex h-3 w-3 rounded-full bg-current" />
            </span>
          )}
          {icon}
        </div>
      </div>
    </div>
  );
}
