import {
  getProfile,
  listWatchlist,
  now,
  nnum,
  nstr,
  num,
  query,
  run,
  str,
} from "./db";
import { enrichEmail } from "./enrichment";
import { generateSequence, scheduleFor } from "./messaging";
import { scoreSignals } from "./scoring";
import { collectSignals } from "./signals/registry";
import type { Signal } from "./signals/types";

export interface RunOptions {
  /** Restrict to specific provider ids. Omit to run every enabled provider. */
  providers?: string[];
  /** Leads at or above this total score get enriched and written a sequence. */
  threshold?: number;
  /** Max leads to enrich + write copy for in one run (each costs a model call). */
  maxOutreach?: number;
  channel?: "email" | "linkedin";
  perProviderLimit?: number;
}

export interface RunStats {
  runId: number;
  signalsFound: number;
  signalsNew: number;
  scored: number;
  qualified: number;
  disqualified: number;
  enriched: number;
  sequencesWritten: number;
  providerErrors: { provider: string; error: string }[];
  /** Non-fatal source problems — a 404 board, a blocked host, an empty watchlist. */
  providerWarnings: { provider: string; warning: string }[];
  outreachErrors: { company: string; error: string }[];
  /** Set when the run stopped early to stay inside the serverless time budget. */
  truncated: boolean;
  durationMs: number;
}

/**
 * Default ceiling on a single run's wall time. Serverless functions are killed
 * at their `maxDuration`, and a kill mid-run leaves leads enriched but with no
 * copy written. Stopping early on purpose keeps the database consistent and
 * reports what was skipped.
 */
const DEFAULT_BUDGET_MS = Number(process.env.JUNIPER_RUN_BUDGET_MS ?? 50_000);

/**
 * The five stages end to end: ingest -> score -> filter -> enrich -> write.
 *
 * Stages that cost money (scoring, copy) run only on what survived the previous
 * filter, which is the whole economic argument for signal-based prospecting.
 */
export async function runPipeline(opts: RunOptions = {}): Promise<RunStats> {
  const {
    providers,
    threshold = 60,
    maxOutreach = 4,
    channel = "email",
    perProviderLimit = 12,
  } = opts;

  const profile = await getProfile();
  if (!profile) {
    throw new Error("No profile yet. Add your website on the Settings tab first.");
  }

  const started = Date.now();
  const deadline = started + DEFAULT_BUDGET_MS;
  const runRes = await run("INSERT INTO runs (started_at) VALUES (?)", [now()]);
  const runId = Number(runRes.lastInsertRowid ?? 0);

  const stats: RunStats = {
    runId,
    signalsFound: 0,
    signalsNew: 0,
    scored: 0,
    qualified: 0,
    disqualified: 0,
    enriched: 0,
    sequencesWritten: 0,
    providerErrors: [],
    providerWarnings: [],
    outreachErrors: [],
    truncated: false,
    durationMs: 0,
  };

  try {
    // 1. Ingest ------------------------------------------------------------
    const watchlist = await listWatchlist();
    const results = await collectSignals(
      {
        watchlist: watchlist.map((w) => ({
          provider: w.provider,
          handle: w.handle,
          label: w.label,
          domain: w.domain,
        })),
        keywords: profile.icp.watchTerms,
        limit: perProviderLimit,
      },
      providers,
    );

    const found: Signal[] = [];
    for (const r of results) {
      if (r.error) stats.providerErrors.push({ provider: r.provider, error: r.error });
      for (const warning of r.warnings) {
        stats.providerWarnings.push({ provider: r.provider, warning });
      }
      found.push(...r.signals);
    }
    stats.signalsFound = found.length;

    const fresh: Signal[] = [];
    for (const s of found) if (await persistSignal(s)) fresh.push(s);
    stats.signalsNew = fresh.length;
    if (fresh.length === 0) return await finish(runId, stats, started);

    // 2. Score -------------------------------------------------------------
    const scored = await scoreSignals(profile, fresh);
    stats.scored = scored.length;

    for (const s of scored) {
      const signalId = await signalIdFor(s.signal.dedupeKey);
      if (!signalId) continue;
      if (s.disqualified) stats.disqualified++;
      else stats.qualified++;

      await run(
        `INSERT INTO leads
           (signal_id, company, domain, person_name, person_title,
            fit_score, intent_score, total_score, rationale, disqualified, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(signal_id) DO UPDATE SET
           fit_score = excluded.fit_score,
           intent_score = excluded.intent_score,
           total_score = excluded.total_score,
           rationale = excluded.rationale,
           disqualified = excluded.disqualified`,
        [
          signalId,
          s.signal.company,
          s.signal.domain,
          s.signal.personName,
          s.signal.personTitle,
          s.fitScore,
          s.intentScore,
          s.totalScore,
          s.rationale,
          s.disqualified ? 1 : 0,
          s.disqualified ? "disqualified" : "scored",
          now(),
        ],
      );
    }

    // 3/4/5. Enrich and write copy for the survivors only -------------------
    const shortlist = scored
      .filter((s) => !s.disqualified && s.totalScore >= threshold)
      .slice(0, maxOutreach);

    for (const s of shortlist) {
      if (Date.now() > deadline) {
        stats.truncated = true;
        break;
      }

      const signalId = await signalIdFor(s.signal.dedupeKey);
      if (!signalId) continue;
      const leadRows = await query("SELECT id FROM leads WHERE signal_id = ?", [signalId]);
      if (leadRows.length === 0) continue;
      const leadId = num(leadRows[0].id);

      const enrichment = await enrichEmail({
        personName: s.signal.personName,
        domain: s.signal.domain,
      });
      if (enrichment.email) stats.enriched++;

      await run(
        `UPDATE leads SET email = ?, email_source = ?, email_confidence = ?, status = ?
         WHERE id = ?`,
        [
          enrichment.email,
          enrichment.source,
          enrichment.confidence,
          enrichment.email ? "enriched" : "scored",
          leadId,
        ],
      );

      // An email-channel sequence with no address is not sendable; LinkedIn
      // messages don't need one.
      if (channel === "email" && !enrichment.email) continue;

      try {
        const seq = await generateSequence(profile, s.signal, channel);
        await writeSequence(leadId, channel, seq);
        stats.sequencesWritten++;
        await run("UPDATE leads SET status = 'sequenced' WHERE id = ?", [leadId]);
      } catch (err) {
        stats.outreachErrors.push({
          company: s.signal.company,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    return await finish(runId, stats, started);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    stats.durationMs = Date.now() - started;
    await run(
      "UPDATE runs SET finished_at = ?, ok = 0, error = ?, stats_json = ? WHERE id = ?",
      [now(), message, JSON.stringify(stats), runId],
    );
    throw err;
  }
}

// ------------------------------------------------------------------ helpers

/** Returns true when the signal was new (INSERT OR IGNORE actually inserted). */
async function persistSignal(s: Signal): Promise<boolean> {
  const res = await run(
    `INSERT OR IGNORE INTO signals
       (provider, kind, company, domain, person_name, person_title,
        headline, evidence, url, strength, detected_at, dedupe_key)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      s.provider,
      s.kind,
      s.company,
      s.domain,
      s.personName,
      s.personTitle,
      s.headline,
      s.evidence,
      s.url,
      0,
      s.detectedAt,
      s.dedupeKey,
    ],
  );
  return Number(res.rowsAffected) > 0;
}

async function signalIdFor(dedupeKey: string): Promise<number | null> {
  const rows = await query("SELECT id FROM signals WHERE dedupe_key = ?", [dedupeKey]);
  return rows.length ? num(rows[0].id) : null;
}

async function writeSequence(
  leadId: number,
  channel: string,
  seq: { subject: string; body: string; followUps: { dayOffset: number; body: string }[] },
): Promise<void> {
  await run("DELETE FROM messages WHERE lead_id = ?", [leadId]);
  const sql = `INSERT INTO messages (lead_id, channel, step, subject, body, scheduled_at)
               VALUES (?, ?, ?, ?, ?, ?)`;
  await run(sql, [leadId, channel, 0, seq.subject || null, seq.body, scheduleFor(0)]);
  for (const [i, f] of seq.followUps.entries()) {
    await run(sql, [leadId, channel, i + 1, null, f.body, scheduleFor(f.dayOffset)]);
  }
}

async function finish(runId: number, stats: RunStats, started: number): Promise<RunStats> {
  stats.durationMs = Date.now() - started;
  await run("UPDATE runs SET finished_at = ?, ok = 1, stats_json = ? WHERE id = ?", [
    now(),
    JSON.stringify(stats),
    runId,
  ]);
  return stats;
}

// --------------------------------------------------------------- read model

export interface LeadView {
  id: number;
  company: string;
  domain: string | null;
  personName: string | null;
  personTitle: string | null;
  fitScore: number;
  intentScore: number;
  totalScore: number;
  rationale: string;
  disqualified: boolean;
  email: string | null;
  emailSource: string | null;
  emailConfidence: number | null;
  status: string;
  createdAt: string;
  signal: {
    provider: string;
    kind: string;
    headline: string;
    evidence: string;
    url: string | null;
    detectedAt: string;
  };
  messages: {
    id: number;
    step: number;
    channel: string;
    subject: string | null;
    body: string;
    scheduledAt: string;
    status: string;
  }[];
}

export async function listLeads(
  opts: { includeDisqualified?: boolean } = {},
): Promise<LeadView[]> {
  const rows = await query(
    `SELECT l.*, s.provider, s.kind, s.headline, s.evidence, s.url, s.detected_at
     FROM leads l JOIN signals s ON s.id = l.signal_id
     ${opts.includeDisqualified ? "" : "WHERE l.disqualified = 0"}
     ORDER BY l.total_score DESC, l.created_at DESC`,
  );
  const messages = await query("SELECT * FROM messages ORDER BY lead_id, step");

  return rows.map((r) => ({
    id: num(r.id),
    company: str(r.company),
    domain: nstr(r.domain),
    personName: nstr(r.person_name),
    personTitle: nstr(r.person_title),
    fitScore: num(r.fit_score),
    intentScore: num(r.intent_score),
    totalScore: num(r.total_score),
    rationale: str(r.rationale),
    disqualified: num(r.disqualified) === 1,
    email: nstr(r.email),
    emailSource: nstr(r.email_source),
    emailConfidence: nnum(r.email_confidence),
    status: str(r.status),
    createdAt: str(r.created_at),
    signal: {
      provider: str(r.provider),
      kind: str(r.kind),
      headline: str(r.headline),
      evidence: str(r.evidence),
      url: nstr(r.url),
      detectedAt: str(r.detected_at),
    },
    messages: messages
      .filter((m) => num(m.lead_id) === num(r.id))
      .map((m) => ({
        id: num(m.id),
        step: num(m.step),
        channel: str(m.channel),
        subject: nstr(m.subject),
        body: str(m.body),
        scheduledAt: str(m.scheduled_at),
        status: str(m.status),
      })),
  }));
}

export interface SignalFeedRow {
  id: number;
  provider: string;
  kind: string;
  company: string;
  headline: string;
  evidence: string;
  url: string | null;
  detectedAt: string;
  totalScore: number | null;
  disqualified: boolean;
}

export async function listSignalFeed(limit = 60): Promise<SignalFeedRow[]> {
  const rows = await query(
    `SELECT s.*, l.total_score, l.disqualified
     FROM signals s LEFT JOIN leads l ON l.signal_id = s.id
     ORDER BY s.detected_at DESC LIMIT ?`,
    [limit],
  );

  return rows.map((r) => ({
    id: num(r.id),
    provider: str(r.provider),
    kind: str(r.kind),
    company: str(r.company),
    headline: str(r.headline),
    evidence: str(r.evidence),
    url: nstr(r.url),
    detectedAt: str(r.detected_at),
    totalScore: nnum(r.total_score),
    disqualified: num(r.disqualified ?? 0) === 1,
  }));
}

export async function latestRun() {
  const rows = await query("SELECT * FROM runs ORDER BY id DESC LIMIT 1");
  return rows[0] ?? null;
}
