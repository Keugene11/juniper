import { ashbyProvider } from "./ashby";
import { crunchbaseProvider } from "./crunchbase";
import { greenhouseProvider } from "./greenhouse";
import { hackerNewsProvider } from "./hackernews";
import { leverProvider } from "./lever";
import { linkedInProvider } from "./linkedin";
import { redditProvider } from "./reddit";
import { simulatorProvider } from "./simulator";
import { unipileProvider } from "./unipile";
import {
  isSignalKind,
  SIGNAL_KINDS,
  type ProviderContext,
  type Signal,
  type SignalKind,
  type SignalProvider,
} from "./types";

export const PROVIDERS: SignalProvider[] = [
  simulatorProvider,
  greenhouseProvider,
  leverProvider,
  ashbyProvider,
  hackerNewsProvider,
  redditProvider,
  crunchbaseProvider,
  unipileProvider,
  linkedInProvider,
];

/** Providers whose watchlist entries are handles rather than keywords. */
export const WATCHLIST_PROVIDERS = ["greenhouse", "lever", "ashby", "unipile"] as const;

export function getProvider(id: string): SignalProvider | undefined {
  return PROVIDERS.find((p) => p.id === id);
}

/** Environment variables a provider needs but does not have. */
export function missingSecrets(p: SignalProvider): string[] {
  return p.requires.filter((k) => !process.env[k]);
}

/** Enabled *and* configured — the set a run will actually call. */
export function runnableProviders(): SignalProvider[] {
  return PROVIDERS.filter((p) => p.enabled && missingSecrets(p).length === 0);
}

export interface ProviderStatus {
  id: string;
  label: string;
  description: string;
  enabled: boolean;
  /** False when an enabled provider is missing credentials. */
  configured: boolean;
  missing: string[];
  kinds: SignalKind[];
}

/**
 * Drives the Setup tab. An unconfigured provider stays visible and names the
 * variable it wants rather than silently disappearing from the list — the
 * difference between "this source found nothing" and "this source never ran"
 * is the whole reason the warnings channel exists.
 */
export function providerStatus(): ProviderStatus[] {
  return PROVIDERS.map((p) => ({
    id: p.id,
    label: p.label,
    description: p.description,
    enabled: p.enabled,
    configured: missingSecrets(p).length === 0,
    missing: missingSecrets(p),
    kinds: p.kinds,
  }));
}

/**
 * Signal kinds a run could actually produce right now. The trigger picker is
 * built from these, so nobody selects a kind whose only source is disabled or
 * unconfigured and then waits for signals that cannot arrive.
 */
export function collectableKinds(): SignalKind[] {
  const out = new Set<SignalKind>();
  for (const p of runnableProviders()) for (const k of p.kinds) out.add(k);
  // Ordered by the taxonomy, not by provider registration, so the picker always
  // reads strongest-intent-first.
  return SIGNAL_KINDS.filter((k) => out.has(k));
}

export function parseKinds(v: unknown): SignalKind[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const kinds = v.filter(isSignalKind);
  return kinds.length ? kinds : undefined;
}

export interface ProviderResult {
  provider: string;
  signals: Signal[];
  /** Non-fatal per-target problems. */
  warnings: string[];
  /** Set when the provider failed outright and returned nothing. */
  error?: string;
}

/**
 * Runs every runnable provider concurrently. One provider failing (a rate
 * limit, a moved job board) degrades that source only — the run still returns
 * whatever the others found, and the failure is reported rather than swallowed.
 */
export async function collectSignals(
  ctx: ProviderContext,
  only?: string[],
): Promise<ProviderResult[]> {
  const selected = PROVIDERS.filter((p) => p.enabled && (!only || only.includes(p.id)));

  // Enabled but unconfigured sources report themselves rather than vanishing.
  const unconfigured: ProviderResult[] = selected
    .filter((p) => missingSecrets(p).length > 0)
    .map((p) => ({
      provider: p.id,
      signals: [],
      warnings: [`not configured — set ${missingSecrets(p).join(", ")} to enable this source`],
    }));

  const active = selected.filter((p) => missingSecrets(p).length === 0);

  const results = await Promise.all(
    active.map(async (p): Promise<ProviderResult> => {
      try {
        // Each provider only ever sees the watchlist entries addressed to it,
        // so a Lever handle is never dialled against a Greenhouse board.
        const scoped: ProviderContext = {
          ...ctx,
          watchlist: ctx.watchlist.filter((w) => w.provider === p.id),
        };
        const { signals, warnings } = await p.fetch(scoped);
        return { provider: p.id, signals, warnings };
      } catch (err) {
        return {
          provider: p.id,
          signals: [],
          warnings: [],
          error: err instanceof Error ? err.message : String(err),
        };
      }
    }),
  );

  return [...results, ...unconfigured];
}
