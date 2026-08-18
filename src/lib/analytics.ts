import { num, nstr, query, str } from "./db";
import { SIGNAL_STRENGTH, type SignalKind } from "./signals/types";
import type { RunStats } from "./pipeline";

/**
 * The reporting half of the product. Everything here reads from the same tables
 * the pipeline writes, so there is no separate event log to fall out of sync.
 *
 * The question worth answering is not "how many leads did we generate" but
 * "which trigger events actually produce replies" — that is the only feedback
 * that can correct the intent weights in `SIGNAL_STRENGTH`, which are otherwise
 * just an opinion baked into a constant.
 */

const CONTACTED = "('contacted','replied','meeting','lost')";
const REPLIED = "('replied','meeting')";

export interface Funnel {
  signals: number;
  scored: number;
  qualified: number;
  withEmail: number;
  sequenced: number;
  contacted: number;
  replied: number;
  meetings: number;
}

export async function funnel(): Promise<Funnel> {
  const [rows] = await query(
    `SELECT
       (SELECT COUNT(*) FROM signals)                                  AS signals,
       (SELECT COUNT(*) FROM leads)                                    AS scored,
       (SELECT COUNT(*) FROM leads WHERE disqualified = 0)             AS qualified,
       (SELECT COUNT(*) FROM leads WHERE email IS NOT NULL)            AS with_email,
       (SELECT COUNT(DISTINCT lead_id) FROM messages)                  AS sequenced,
       (SELECT COUNT(*) FROM leads WHERE outcome IN ${CONTACTED})      AS contacted,
       (SELECT COUNT(*) FROM leads WHERE outcome IN ${REPLIED})        AS replied,
       (SELECT COUNT(*) FROM leads WHERE outcome = 'meeting')          AS meetings`,
  );

  return {
    signals: num(rows.signals),
    scored: num(rows.scored),
    qualified: num(rows.qualified),
    withEmail: num(rows.with_email),
    sequenced: num(rows.sequenced),
    contacted: num(rows.contacted),
    replied: num(rows.replied),
    meetings: num(rows.meetings),
  };
}

export interface KindPerformance {
  kind: SignalKind;
  /** The taxonomy's assumed peak intent, for comparison against what happened. */
  assumedIntent: number;
  leads: number;
  qualified: number;
  avgFit: number;
  sequenced: number;
  contacted: number;
  replied: number;
  meetings: number;
  /** Replies over contacts. Null until at least one lead of this kind was contacted. */
  replyRate: number | null;
}

/**
 * Per-trigger conversion. `assumedIntent` sits next to the measured reply rate
 * on purpose: when a kind is weighted 95 and has never once produced a reply,
 * the weight is wrong for this seller and should be argued with.
 */
export async function kindPerformance(): Promise<KindPerformance[]> {
  const rows = await query(
    `SELECT s.kind                                                       AS kind,
            COUNT(*)                                                     AS leads,
            SUM(CASE WHEN l.disqualified = 0 THEN 1 ELSE 0 END)          AS qualified,
            AVG(l.fit_score)                                             AS avg_fit,
            SUM(CASE WHEN m.lead_id IS NOT NULL THEN 1 ELSE 0 END)       AS sequenced,
            SUM(CASE WHEN l.outcome IN ${CONTACTED} THEN 1 ELSE 0 END)   AS contacted,
            SUM(CASE WHEN l.outcome IN ${REPLIED} THEN 1 ELSE 0 END)     AS replied,
            SUM(CASE WHEN l.outcome = 'meeting' THEN 1 ELSE 0 END)       AS meetings
     FROM leads l
     JOIN signals s ON s.id = l.signal_id
     LEFT JOIN (SELECT DISTINCT lead_id FROM messages) m ON m.lead_id = l.id
     GROUP BY s.kind`,
  );

  return rows
    .map((r) => {
      const contacted = num(r.contacted);
      const replied = num(r.replied);
      return {
        kind: str(r.kind) as SignalKind,
        assumedIntent: SIGNAL_STRENGTH[str(r.kind) as SignalKind] ?? 0,
        leads: num(r.leads),
        qualified: num(r.qualified),
        avgFit: Math.round(Number(r.avg_fit ?? 0)),
        sequenced: num(r.sequenced),
        contacted,
        replied,
        meetings: num(r.meetings),
        replyRate: contacted > 0 ? replied / contacted : null,
      };
    })
    .sort((a, b) => b.leads - a.leads);
}

export interface ProviderPerformance {
  provider: string;
  signals: number;
  scored: number;
  qualified: number;
  /** Share of this source's scored signals that survived ICP filtering. */
  precision: number | null;
}

/**
 * Source quality. A provider that produces plenty of signals and no qualified
 * leads is costing scoring calls for nothing, and is a candidate for tighter
 * keywords rather than a bigger limit.
 */
export async function providerPerformance(): Promise<ProviderPerformance[]> {
  const rows = await query(
    `SELECT s.provider                                              AS provider,
            COUNT(*)                                                AS signals,
            SUM(CASE WHEN l.id IS NOT NULL THEN 1 ELSE 0 END)       AS scored,
            SUM(CASE WHEN l.disqualified = 0 THEN 1 ELSE 0 END)     AS qualified
     FROM signals s
     LEFT JOIN leads l ON l.signal_id = s.id
     GROUP BY s.provider
     ORDER BY signals DESC`,
  );

  return rows.map((r) => {
    const scored = num(r.scored);
    return {
      provider: str(r.provider),
      signals: num(r.signals),
      scored,
      qualified: num(r.qualified),
      precision: scored > 0 ? num(r.qualified) / scored : null,
    };
  });
}

export interface RunRecord {
  id: number;
  startedAt: string;
  finishedAt: string | null;
  ok: boolean;
  error: string | null;
  stats: Partial<RunStats>;
}

export async function recentRuns(limit = 12): Promise<RunRecord[]> {
  const rows = await query("SELECT * FROM runs ORDER BY id DESC LIMIT ?", [limit]);
  return rows.map((r) => ({
    id: num(r.id),
    startedAt: str(r.started_at),
    finishedAt: nstr(r.finished_at),
    ok: num(r.ok) === 1,
    error: nstr(r.error),
    stats: parseStats(nstr(r.stats_json)),
  }));
}

/** A half-written stats blob from a killed run must not take the page down. */
function parseStats(json: string | null): Partial<RunStats> {
  if (!json) return {};
  try {
    const parsed: unknown = JSON.parse(json);
    return parsed && typeof parsed === "object" ? (parsed as Partial<RunStats>) : {};
  } catch {
    return {};
  }
}
