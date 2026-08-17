import { greenhouseProvider } from "./greenhouse";
import { hackerNewsProvider } from "./hackernews";
import { leverProvider } from "./lever";
import { linkedInProvider } from "./linkedin";
import { simulatorProvider } from "./simulator";
import type { ProviderContext, Signal, SignalProvider } from "./types";

export const PROVIDERS: SignalProvider[] = [
  simulatorProvider,
  greenhouseProvider,
  leverProvider,
  hackerNewsProvider,
  linkedInProvider,
];

export function getProvider(id: string): SignalProvider | undefined {
  return PROVIDERS.find((p) => p.id === id);
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
 * Runs every enabled provider concurrently. One provider failing (a rate limit,
 * a moved job board) degrades that source only — the run still returns whatever
 * the others found, and the failure is reported rather than swallowed.
 */
export async function collectSignals(
  ctx: ProviderContext,
  only?: string[],
): Promise<ProviderResult[]> {
  const active = PROVIDERS.filter((p) => p.enabled && (!only || only.includes(p.id)));

  return Promise.all(
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
}
