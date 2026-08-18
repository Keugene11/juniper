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
import { outboundConfigured, pushLead, type PushOutcome } from "./outbound";
import { isLeadOutcome, type LeadOutcome } from "./outcomes";
import { scoreSignals } from "./scoring";
import { collectSignals } from "./signals/registry";
import {
  freshness,
  SIGNAL_STRENGTH,
  type Signal,
  type SignalKind,
} from "./signals/types";

// Re-exported so callers that already depend on the pipeline read model do not
// need a second import for the outcome vocabulary.
export { isLeadOutcome, LEAD_OUTCOMES, OUTCOME_LABEL, type LeadOutcome } from "./outcomes";

/** Thrown when the pipeline runs before an ICP exists — a precondition, not a fault. */
export class MissingProfileError extends Error {
  constructor() {
    super("No targeting profile yet. Add your website on the Setup tab first.");
  }
}

export interface RunOptions {
  /** Restrict to specific provider ids. Omit to run every enabled provider. */
  providers?: string[];
  /**
   * Restrict to specific signal kinds. Omit to accept every kind a provider
   * emits. This is a *watch* setting rather than a view filter: unselected
   * kinds are dropped before they are persisted, so they never reach scoring
   * and never cost a model call.
   */
  kinds?: SignalKind[];
  /** Leads at or above this total score get enriched and written a sequence. */
  threshold?: number;
  /** Max leads to enrich + write copy for in one run (each costs a model call). */
  maxOutreach?: number;
  channel?: "email" | "linkedin";
  perProviderLimit?: number;
  /**
   * Push qualified leads to the configured outbound destinations as they are
   * written. Defaults to JUNIPER_AUTO_PUSH=1 — off unless asked for, because a
   * push writes to systems other people are looking at.
   */
  autoPush?: boolean;
}

export interface RunStats {
  runId: number;
  signalsFound: number;
  /** Dropped because their kind was not selected for this run. */
  signalsFiltered: number;
  signalsNew: number;
  scored: number;
  qualified: number;
  disqualified: number;
  enriched: number;
  sequencesWritten: number;
  /** Leads sent to at least one outbound destination successfully. */
  pushed: number;
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
    kinds,
    threshold = 60,
    maxOutreach = 4,
    channel = "email",
    perProviderLimit = 12,
    autoPush = process.env.JUNIPER_AUTO_PUSH === "1",
  } = opts;

  const profile = await getProfile();
  if (!profile) throw new MissingProfileError();

  const started = Date.now();
  const deadline = started + DEFAULT_BUDGET_MS;
  const runRes = await run("INSERT INTO runs (started_at) VALUES (?)", [now()]);
  const runId = Number(runRes.lastInsertRowid ?? 0);

  const stats: RunStats = {
    runId,
    signalsFound: 0,
    signalsFiltered: 0,
    signalsNew: 0,
    scored: 0,
    qualified: 0,
    disqualified: 0,
    enriched: 0,
    sequencesWritten: 0,
    pushed: 0,
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

    const selected = kinds ? found.filter((s) => kinds.includes(s.kind)) : found;
    stats.signalsFiltered = found.length - selected.length;

    const fresh: Signal[] = [];
    for (const s of selected) if (await persistSignal(s)) fresh.push(s);
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

        // Opt-in, because a push is visible to other people: it drops a record
        // into a shared CRM or a team channel. Nobody should discover that by
        // running the pipeline for the first time.
        if (autoPush && outboundConfigured()) {
          const outcomes = await pushLeadById(leadId);
          if (outcomes?.some((o) => o.ok)) stats.pushed++;
          for (const o of outcomes ?? []) {
            if (!o.ok && !o.detail.startsWith("skipped")) {
              stats.outreachErrors.push({
                company: s.signal.company,
                error: `${o.target}: ${o.detail}`,
              });
            }
          }
        }
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
        headline, evidence, url, strength, detected_at, occurred_at, dedupe_key)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
      // Peak strength for the kind. Stored undecayed on purpose: the row is a
      // record of the event, and how stale it is depends on when you ask.
      SIGNAL_STRENGTH[s.kind],
      s.detectedAt,
      s.occurredAt,
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
  /** What actually happened after you reached out. Set by hand from the UI. */
  outcome: LeadOutcome;
  outcomeAt: string | null;
  pushedAt: string | null;
  /** Per-destination result of the last push. */
  pushResult: PushOutcome[];
  createdAt: string;
  signal: {
    provider: string;
    kind: string;
    headline: string;
    evidence: string;
    url: string | null;
    detectedAt: string;
    occurredAt: string | null;
    /** Recomputed on read, so a lead visibly cools while it sits in the list. */
    freshness: number;
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

/** A half-written blob from an interrupted push must not take the page down. */
function parsePushResult(json: string | null): PushOutcome[] {
  if (!json) return [];
  try {
    const parsed: unknown = JSON.parse(json);
    return Array.isArray(parsed) ? (parsed as PushOutcome[]) : [];
  } catch {
    return [];
  }
}

/**
 * Sends a lead to every configured outbound destination and records what each
 * one said. Returns null when the id matches no lead, so the route can 404.
 */
export async function pushLeadById(id: number): Promise<PushOutcome[] | null> {
  const lead = await getLead(id);
  if (!lead) return null;

  const profile = await getProfile();
  const outcomes = await pushLead(lead, profile);

  await run("UPDATE leads SET pushed_at = ?, push_result = ? WHERE id = ?", [
    now(),
    JSON.stringify(outcomes),
    id,
  ]);
  return outcomes;
}

export async function getLead(id: number): Promise<LeadView | null> {
  const all = await listLeads({ includeDisqualified: true });
  return all.find((l) => l.id === id) ?? null;
}

/** Returns false when the id matches no lead, so the route can answer 404. */
export async function setLeadOutcome(id: number, outcome: LeadOutcome): Promise<boolean> {
  const res = await run(
    "UPDATE leads SET outcome = ?, outcome_at = ? WHERE id = ?",
    [outcome, outcome === "none" ? null : now(), id],
  );
  return Number(res.rowsAffected) > 0;
}

export async function listLeads(
  opts: { includeDisqualified?: boolean } = {},
): Promise<LeadView[]> {
  const rows = await query(
    `SELECT l.*, s.provider, s.kind, s.headline, s.evidence, s.url, s.detected_at, s.occurred_at
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
    outcome: (isLeadOutcome(r.outcome) ? r.outcome : "none") as LeadOutcome,
    outcomeAt: nstr(r.outcome_at),
    pushedAt: nstr(r.pushed_at),
    pushResult: parsePushResult(nstr(r.push_result)),
    createdAt: str(r.created_at),
    signal: {
      provider: str(r.provider),
      kind: str(r.kind),
      headline: str(r.headline),
      evidence: str(r.evidence),
      url: nstr(r.url),
      detectedAt: str(r.detected_at),
      occurredAt: nstr(r.occurred_at),
      freshness: freshness(
        str(r.kind) as SignalKind,
        nstr(r.occurred_at) ?? str(r.detected_at),
      ),
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
  occurredAt: string | null;
  /** Share of peak intent left as of now, 0.1-1. */
  freshness: number;
  totalScore: number | null;
  disqualified: boolean;
}

export async function listSignalFeed(limit = 60): Promise<SignalFeedRow[]> {
  const rows = await query(
    `SELECT s.*, l.total_score, l.disqualified
     FROM signals s LEFT JOIN leads l ON l.signal_id = s.id
     ORDER BY COALESCE(s.occurred_at, s.detected_at) DESC LIMIT ?`,
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
    occurredAt: nstr(r.occurred_at),
    freshness: freshness(
      str(r.kind) as SignalKind,
      nstr(r.occurred_at) ?? str(r.detected_at),
    ),
    totalScore: nnum(r.total_score),
    disqualified: num(r.disqualified ?? 0) === 1,
  }));
}

export async function latestRun() {
  const rows = await query("SELECT * FROM runs ORDER BY id DESC LIMIT 1");
  return rows[0] ?? null;
}
