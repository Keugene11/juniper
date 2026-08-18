import type { ReactNode } from "react";
import { freshnessLabel } from "@/lib/signals/types";

export function PageHeader({ title, sub }: { title: string; sub?: string }) {
  return (
    <div className="mb-5">
      <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
      {sub && <p className="mt-1 text-sm leading-relaxed text-muted">{sub}</p>}
    </div>
  );
}

export function Card({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <div className={`card p-4 ${className}`}>{children}</div>;
}

export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="card border-dashed p-8 text-center">
      <p className="text-sm font-medium">{title}</p>
      {children && <div className="mt-2 text-sm leading-relaxed text-muted">{children}</div>}
    </div>
  );
}

export function Badge({
  children,
  tone = "neutral",
}: {
  children: ReactNode;
  tone?: "neutral" | "solid" | "quiet";
}) {
  const tones = {
    neutral: "border border-line text-ink",
    solid: "bg-ink text-paper",
    quiet: "bg-wash text-muted",
  };
  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium ${tones[tone]}`}
    >
      {children}
    </span>
  );
}

/**
 * How much of the event's intent is left. Shown next to the score because the
 * score was computed when the signal was ingested: a lead that was an 82 last
 * week is not an 82 today, and the tag is what makes that visible without
 * re-running scoring.
 */
export function FreshnessTag({ value }: { value: number }) {
  const band = freshnessLabel(value);
  const tone = band === "hot" ? "solid" : band === "warm" ? "neutral" : "quiet";
  return (
    <Badge tone={tone}>
      {band} · {Math.round(value * 100)}%
    </Badge>
  );
}

/** Score with a bar, so relative strength reads at a glance on mobile. */
export function ScoreBar({ label, value }: { label: string; value: number }) {
  return (
    <div>
      <div className="flex items-baseline justify-between text-[11px] text-muted">
        <span>{label}</span>
        <span className="font-medium text-ink tabular-nums">{value}</span>
      </div>
      <div className="mt-1 h-1 w-full overflow-hidden rounded-full bg-wash">
        <div className="h-full rounded-full bg-ink" style={{ width: `${value}%` }} />
      </div>
    </div>
  );
}

export function Stat({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="card px-3 py-2.5">
      <div className="text-lg font-semibold tabular-nums leading-none">{value}</div>
      <div className="mt-1 text-[11px] text-muted">{label}</div>
    </div>
  );
}

export function relativeTime(iso: string): string {
  const diff = Date.now() - Date.parse(iso);
  const mins = Math.round(diff / 60_000);
  if (Number.isNaN(mins)) return "";
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}
