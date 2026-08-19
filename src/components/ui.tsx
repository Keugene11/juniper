import type { ReactNode } from "react";
import { freshnessLabel } from "@/lib/signals/types";

export function PageHeader({ title, sub }: { title: string; sub?: string }) {
  return (
    <div className="mb-6">
      <h1 className="display text-[38px] md:text-[44px]">{title}</h1>
      {sub && (
        <p className="mt-3 max-w-[58ch] text-[17px] leading-relaxed text-muted">{sub}</p>
      )}
    </div>
  );
}

export function Card({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <div className={`card p-5 ${className}`}>{children}</div>;
}

export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="card border-dashed p-10 text-center shadow-none">
      <p className="text-base font-medium">{title}</p>
      {children && (
        <div className="mx-auto mt-2 max-w-[46ch] text-sm leading-relaxed text-muted">
          {children}
        </div>
      )}
    </div>
  );
}

export function Badge({
  children,
  tone = "neutral",
}: {
  children: ReactNode;
  tone?: "neutral" | "solid" | "quiet" | "accent";
}) {
  const tones = {
    neutral: "border border-line text-ink",
    solid: "bg-ink text-paper",
    quiet: "bg-sunken text-muted",
    accent: "bg-accent-tint text-accent-deep",
  };
  return (
    <span
      className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${tones[tone]}`}
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
 *
 * Hot borrows the accent — a signal worth acting on today is exactly the kind of
 * thing colour should be spent on.
 */
export function FreshnessTag({ value }: { value: number }) {
  const band = freshnessLabel(value);
  const tone = band === "hot" ? "accent" : band === "warm" ? "neutral" : "quiet";
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
      <div className="flex items-baseline justify-between text-xs text-muted">
        <span>{label}</span>
        <span className="font-medium tabular-nums text-ink">{value}</span>
      </div>
      <div className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-sunken">
        <div
          className="h-full rounded-full bg-ink transition-[width] duration-500"
          style={{ width: `${Math.max(0, Math.min(100, value))}%` }}
        />
      </div>
    </div>
  );
}

export function Stat({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="card px-4 py-3">
      <div className="headline text-[28px] tabular-nums">
        {value}
      </div>
      <div className="mt-1.5 text-xs text-muted">{label}</div>
    </div>
  );
}

/** The number a lead is judged on. Large, and the one place a figure gets colour. */
export function ScoreDial({ value }: { value: number }) {
  const hot = value >= 70;
  return (
    <div className="shrink-0 text-right">
      <div
        className={`display text-[34px] tabular-nums ${
          hot ? "text-accent-deep" : "text-ink"
        }`}
      >
        {value}
      </div>
      <div className="mt-1 text-xs text-muted">of 100</div>
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
