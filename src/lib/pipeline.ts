import {
  getProfile,
  listSuppressions,
  listWatchlist,
  now,
  nnum,
  nstr,
  num,
  query,
  run,
  str,
} from "./db";
import { contactKey, contactKeys, matchSuppression } from "./contacts";
import { enrichEmail } from "./enrichment";
import { generateSequence, scheduleFor } from "./messaging";
import { outboundConfigured, pushLead, type PushOutcome } from "./outbound";
import { isLeadOutcome, type LeadOutcome } from "./outcomes";
import { scoreSignals, type ScoredSignal } from "./scoring";
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
  /**
   * Days before the same contact may be sequenced again. Defaults to
   * JUNIPER_CONTACT_COOLDOWN_DAYS (30).
   */
  cooldownDays?: number;
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
  /** Qualified leads that resolved to a contact another lead already owns. */
  deduped: number;
  /** Blocked by the suppression list, a lost outcome, or a booked meeting. */
  suppressed: number;
  /** Blocked because the same contact was sequenced inside the cooldown. */
  cooledDown: number;
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
    cooldownDays = DEFAULT_COOLDOWN_DAYS,
  } = opts;

  const profile = await getProfile();
  if (!profile) throw new MissingProfileError();

  const started = Date.now();
  const deadline = started + DEFAULT_BUDGET_MS;
  const runRes = await run("INSERT INTO runs (started_at) VALUES (?) RETURNING id", [now()]);
  const runId = num(runRes.rows[0].id);

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
    deduped: 0,
    suppressed: 0,
    cooledDown: 0,
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
            fit_score, intent_score, total_score, rationale, disqualified, status,
            contact_key, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(signal_id) DO UPDATE SET
           fit_score = excluded.fit_score,
           intent_score = excluded.intent_score,
           total_score = excluded.total_score,
           rationale = excluded.rationale,
           disqualified = excluded.disqualified,
           contact_key = excluded.contact_key`,
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
          // Written at scoring time so the *next* run can see this contact even
          // if this one never gets as far as enrichment.
          contactKey({
            email: null,
            domain: s.signal.domain,
            personName: s.signal.personName,
          }),
          now(),
        ],
      );
    }

    // 3/4/5. Enrich and write copy for the survivors only -------------------
    //
    // The contact gate runs *before* the maxOutreach slice, not after. Slicing
    // first would let six signals for one company consume the whole run budget
    // and produce a single sequence; gating first spends that budget on six
    // distinct people.
    const qualified = scored.filter((s) => !s.disqualified && s.totalScore >= threshold);
    const gate = await gateContacts(qualified, cooldownDays);
    stats.deduped = gate.deduped;
    stats.suppressed = gate.suppressed;
    stats.cooledDown = gate.cooledDown;
    for (const [dedupeKey, reason] of gate.skipped) {
      await recordSkip(dedupeKey, reason);
    }
    const shortlist = gate.allowed.slice(0, maxOutreach);

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

      // Enrichment is the first point at which the mailbox is known, so the
      // gate has to run a second time: a lead keyed by name last week and by
      // address today is the same human, and a domain suppression is often only
      // discoverable from the address.
      if (enrichment.email) {
        const late = await gateEnrichedContact(
          { email: enrichment.email, domain: s.signal.domain, personName: s.signal.personName },
          leadId,
          cooldownDays,
        );
        if (late) {
          await run("UPDATE leads SET email = ?, skip_reason = ? WHERE id = ?", [
            enrichment.email,
            late,
            leadId,
          ]);
          if (late.startsWith("suppressed")) stats.suppressed++;
          else stats.deduped++;
          continue;
        }
      }

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

// ------------------------------------------------------------ contact gate

/**
 * Default quiet period before the same contact may be sequenced again. Thirty
 * days matches the window the category treats as a fresh approach — long enough
 * that a second message reads as a new conversation rather than a follow-up to
 * one they already ignored.
 */
const DEFAULT_COOLDOWN_DAYS = Number(process.env.JUNIPER_CONTACT_COOLDOWN_DAYS ?? 30);

export interface GateResult {
  allowed: ScoredSignal[];
  /** dedupeKey -> why it was skipped, for writing onto the lead row. */
  skipped: [string, string][];
  deduped: number;
  suppressed: number;
  cooledDown: number;
}

/**
 * Decides which qualified signals may be written a sequence.
 *
 * Four ways to lose, in order of precedence:
 *
 *   1. The contact is on the suppression list.
 *   2. A previous run already reached them and the cooldown has not expired.
 *   3. They said no, or a meeting is already booked — cold outreach is over for
 *      that contact regardless of how long ago it was.
 *   4. A higher-scoring signal this run resolves to the same contact.
 *
 * Candidates arrive sorted by score (scoreSignals sorts descending), so the
 * first claim on a contact key is always the strongest reason to reach out. The
 * losers are recorded rather than dropped: the lead still exists and the Leads
 * tab explains why it has no copy.
 */
export async function gateContacts(
  candidates: ScoredSignal[],
  cooldownDays: number = DEFAULT_COOLDOWN_DAYS,
): Promise<GateResult> {
  const out: GateResult = {
    allowed: [],
    skipped: [],
    deduped: 0,
    suppressed: 0,
    cooledDown: 0,
  };
  if (candidates.length === 0) return out;

  const suppressions = await listSuppressions();
  const history = await contactHistory(
    candidates.flatMap((s) =>
      contactKeys({
        email: null,
        domain: s.signal.domain,
        personName: s.signal.personName,
      }),
    ),
  );

  const cutoff = Date.now() - cooldownDays * 86_400_000;
  /** Contact keys claimed by an earlier, higher-scoring candidate this run. */
  const claimed = new Map<string, string>();

  for (const s of candidates) {
    const identity = {
      email: null,
      domain: s.signal.domain,
      personName: s.signal.personName,
    };
    const keys = contactKeys(identity);

    const suppression = matchSuppression(identity, suppressions);
    if (suppression) {
      out.skipped.push([
        s.signal.dedupeKey,
        `suppressed — ${suppression.kind} "${suppression.value}"` +
          (suppression.reason ? ` (${suppression.reason})` : ""),
      ]);
      out.suppressed++;
      continue;
    }

    const claimedBy = keys.map((k) => claimed.get(k)).find(Boolean);
    if (claimedBy) {
      out.skipped.push([
        s.signal.dedupeKey,
        `duplicate contact — a higher-scoring signal for ${claimedBy} was sequenced this run`,
      ]);
      out.deduped++;
      continue;
    }

    const prior = keys.map((k) => history.get(k)).find(Boolean);
    const blocked = prior ? blockedByHistory(prior, cutoff) : null;
    if (blocked) {
      out.skipped.push([s.signal.dedupeKey, blocked.reason]);
      if (blocked.kind === "cooldown") out.cooledDown++;
      else out.suppressed++;
      continue;
    }

    // An unidentifiable contact (no domain, no person, no address) yields no
    // keys. It is let through rather than dropped — it is still a real lead,
    // and there is nothing for it to collide with.
    for (const k of keys) claimed.set(k, s.signal.company);
    out.allowed.push(s);
  }

  return out;
}

interface PriorContact {
  leadId: number;
  outcome: string;
  /**
   * When this contact was last reached. Drawn from the sequence we wrote *or*
   * from an outcome recorded by hand — someone who marks a lead "contacted"
   * after sending from their own inbox has reached that person just as surely
   * as a generated sequence did, and the cooldown has to honour both or it
   * silently under-counts the ones Juniper did not send itself.
   */
  contactedAt: string | null;
}

/** Why a prior lead for the same contact blocks this one, if it does. */
function blockedByHistory(
  prior: PriorContact,
  cutoff: number,
): { kind: "cooldown" | "outcome"; reason: string } | null {
  if (prior.outcome === "lost") {
    return {
      kind: "outcome",
      reason: `already contacted and marked lost (lead #${prior.leadId}) — not re-approached`,
    };
  }
  if (prior.outcome === "meeting") {
    return {
      kind: "outcome",
      reason: `a meeting is already booked (lead #${prior.leadId}) — cold outreach stops here`,
    };
  }
  if (prior.contactedAt && Date.parse(prior.contactedAt) > cutoff) {
    return {
      kind: "cooldown",
      reason:
        `already contacted ${prior.contactedAt.slice(0, 10)} (lead #${prior.leadId}) — ` +
        "inside the contact cooldown",
    };
  }
  return null;
}

/**
 * Most recent prior lead per contact key, in one query rather than one per
 * candidate. A lead that was scored and never worked carries no contact date,
 * so it does not start a cooldown.
 */
async function contactHistory(keys: string[]): Promise<Map<string, PriorContact>> {
  const unique = [...new Set(keys)];
  const out = new Map<string, PriorContact>();
  if (unique.length === 0) return out;

  const placeholders = unique.map(() => "?").join(",");
  const rows = await query(
    `SELECT l.id, l.contact_key, l.outcome,
            COALESCE(
              (SELECT MIN(m.scheduled_at) FROM messages m WHERE m.lead_id = l.id),
              CASE WHEN l.outcome != 'none' THEN l.outcome_at END
            ) AS contacted_at
     FROM leads l
     WHERE l.contact_key IN (${placeholders})
     ORDER BY l.created_at ASC`,
    unique,
  );

  for (const r of rows) {
    const key = nstr(r.contact_key);
    if (!key) continue;
    const prior: PriorContact = {
      leadId: num(r.id),
      outcome: str(r.outcome ?? "none"),
      contactedAt: nstr(r.contacted_at),
    };
    const existing = out.get(key);
    // A terminal outcome outranks a bare cooldown, and a sequenced lead
    // outranks one that was only scored — so the strongest block wins rather
    // than whichever row happened to sort last.
    if (!existing || rank(prior) >= rank(existing)) out.set(key, prior);
  }
  return out;
}

const rank = (p: PriorContact) =>
  p.outcome === "lost" || p.outcome === "meeting" ? 2 : p.contactedAt ? 1 : 0;

/**
 * The post-enrichment pass. Returns a skip reason, or null to proceed.
 * Excludes the lead's own row, which by now exists and would otherwise look
 * like a prior contact of itself.
 */
async function gateEnrichedContact(
  identity: { email: string; domain: string | null; personName: string | null },
  leadId: number,
  cooldownDays: number,
): Promise<string | null> {
  const suppression = matchSuppression(identity, await listSuppressions());
  if (suppression) {
    return (
      `suppressed — ${suppression.kind} "${suppression.value}"` +
      (suppression.reason ? ` (${suppression.reason})` : "")
    );
  }

  const emailKey = contactKey({ email: identity.email, domain: null, personName: null });
  if (!emailKey) return null;

  const rows = await query(
    `SELECT l.id, l.contact_key, l.outcome,
            COALESCE(
              (SELECT MIN(m.scheduled_at) FROM messages m WHERE m.lead_id = l.id),
              CASE WHEN l.outcome != 'none' THEN l.outcome_at END
            ) AS contacted_at
     FROM leads l
     WHERE l.contact_key = ? AND l.id != ?
     ORDER BY l.created_at DESC LIMIT 1`,
    [emailKey, leadId],
  );
  if (rows.length === 0) return null;

  const prior: PriorContact = {
    leadId: num(rows[0].id),
    outcome: str(rows[0].outcome ?? "none"),
    contactedAt: nstr(rows[0].contacted_at),
  };
  const blocked = blockedByHistory(prior, Date.now() - cooldownDays * 86_400_000);
  return blocked?.reason ?? null;
}

/** Notes on the lead why it was scored but never written to. */
async function recordSkip(dedupeKey: string, reason: string): Promise<void> {
  const signalId = await signalIdFor(dedupeKey);
  if (!signalId) return;
  await run("UPDATE leads SET skip_reason = ? WHERE signal_id = ?", [reason, signalId]);
}

// ------------------------------------------------------------------ helpers

/** Returns true when the signal was new (the insert was not a dedupe collision). */
async function persistSignal(s: Signal): Promise<boolean> {
  const res = await run(
    `INSERT INTO signals
       (provider, kind, company, domain, person_name, person_title,
        headline, evidence, url, strength, detected_at, occurred_at, dedupe_key)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (dedupe_key) DO NOTHING`,
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
  /** Stable identity for the person or company this lead addresses. */
  contactKey: string | null;
  /** Why this lead was scored but never sequenced. Null when it was not skipped. */
  skipReason: string | null;
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
    contactKey: nstr(r.contact_key),
    skipReason: nstr(r.skip_reason),
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
