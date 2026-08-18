import { createClient, type Client, type InValue } from "@libsql/client";
import {
  normaliseSuppression,
  type Suppression,
  type SuppressionKind,
} from "./contacts";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

/**
 * libsql speaks SQLite, so the same schema runs against a local file in dev and
 * a hosted Turso database in production — serverless filesystems are ephemeral
 * and not shared between invocations, so a local file cannot be the store there.
 *
 * Set TURSO_DATABASE_URL (+ TURSO_AUTH_TOKEN) to use the hosted database;
 * otherwise it falls back to ./data/juniper.db.
 */
let client: Client | null = null;
let ready: Promise<Client> | null = null;

const LOCAL_PATH = process.env.JUNIPER_DB_PATH || "./data/juniper.db";

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS profile (
    id           INTEGER PRIMARY KEY CHECK (id = 1),
    website      TEXT NOT NULL,
    company_name TEXT NOT NULL,
    value_prop   TEXT NOT NULL,
    icp_json     TEXT NOT NULL,
    updated_at   TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS watchlist (
    id       INTEGER PRIMARY KEY AUTOINCREMENT,
    provider TEXT NOT NULL,
    handle   TEXT NOT NULL,
    label    TEXT NOT NULL,
    domain   TEXT,
    UNIQUE (provider, handle)
  )`,
  `CREATE TABLE IF NOT EXISTS signals (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    provider     TEXT NOT NULL,
    kind         TEXT NOT NULL,
    company      TEXT NOT NULL,
    domain       TEXT,
    person_name  TEXT,
    person_title TEXT,
    headline     TEXT NOT NULL,
    evidence     TEXT NOT NULL,
    url          TEXT,
    strength     INTEGER NOT NULL,
    detected_at  TEXT NOT NULL,
    occurred_at  TEXT,
    dedupe_key   TEXT NOT NULL UNIQUE
  )`,
  `CREATE TABLE IF NOT EXISTS leads (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    signal_id        INTEGER NOT NULL REFERENCES signals(id) ON DELETE CASCADE,
    company          TEXT NOT NULL,
    domain           TEXT,
    person_name      TEXT,
    person_title     TEXT,
    fit_score        INTEGER NOT NULL,
    intent_score     INTEGER NOT NULL,
    total_score      INTEGER NOT NULL,
    rationale        TEXT NOT NULL,
    disqualified     INTEGER NOT NULL DEFAULT 0,
    email            TEXT,
    email_source     TEXT,
    email_confidence INTEGER,
    status           TEXT NOT NULL DEFAULT 'scored',
    contact_key      TEXT,
    /* Why this lead was scored but never sequenced — a duplicate contact, a
       suppression, or a cooldown. Null means it was not skipped. */
    skip_reason      TEXT,
    outcome          TEXT NOT NULL DEFAULT 'none',
    outcome_at       TEXT,
    pushed_at        TEXT,
    push_result      TEXT,
    created_at       TEXT NOT NULL,
    UNIQUE (signal_id)
  )`,
  `CREATE TABLE IF NOT EXISTS messages (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    lead_id      INTEGER NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
    channel      TEXT NOT NULL,
    step         INTEGER NOT NULL,
    subject      TEXT,
    body         TEXT NOT NULL,
    scheduled_at TEXT NOT NULL,
    sent_at      TEXT,
    status       TEXT NOT NULL DEFAULT 'queued'
  )`,
  `CREATE TABLE IF NOT EXISTS suppressions (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    kind       TEXT NOT NULL,
    value      TEXT NOT NULL,
    reason     TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    UNIQUE (kind, value)
  )`,
  `CREATE TABLE IF NOT EXISTS runs (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    started_at  TEXT NOT NULL,
    finished_at TEXT,
    ok          INTEGER NOT NULL DEFAULT 0,
    stats_json  TEXT NOT NULL DEFAULT '{}',
    error       TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS idx_leads_score ON leads(total_score DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_messages_lead ON messages(lead_id, step)`,
  `CREATE INDEX IF NOT EXISTS idx_signals_detected ON signals(detected_at DESC)`,
];

/**
 * Columns added after the first release. `CREATE TABLE IF NOT EXISTS` is a
 * no-op on an existing database, so new columns have to arrive this way or a
 * deployment against a live Turso instance would silently keep the old shape
 * and fail on first query. SQLite has no `ADD COLUMN IF NOT EXISTS`, so a
 * duplicate-column error is the expected outcome on every run after the first
 * and is swallowed; anything else is re-thrown.
 */
const MIGRATIONS = [
  `ALTER TABLE signals ADD COLUMN occurred_at TEXT`,
  `ALTER TABLE leads ADD COLUMN outcome TEXT NOT NULL DEFAULT 'none'`,
  `ALTER TABLE leads ADD COLUMN outcome_at TEXT`,
  `ALTER TABLE leads ADD COLUMN pushed_at TEXT`,
  `ALTER TABLE leads ADD COLUMN push_result TEXT`,
  `ALTER TABLE leads ADD COLUMN contact_key TEXT`,
  `ALTER TABLE leads ADD COLUMN skip_reason TEXT`,
  // Must follow the ADD COLUMN above rather than sitting in SCHEMA: on an
  // existing database the column does not exist when SCHEMA runs, and indexing
  // a missing column fails the whole initialiser.
  `CREATE INDEX IF NOT EXISTS idx_leads_contact ON leads(contact_key)`,
  // Backfill identities for leads that predate the column. Without this the
  // first run after upgrading would happily re-sequence everyone contacted
  // before it, because none of them would match a contact key.
  //
  // Mirrors `contactKey` in contacts.ts: email wins, then person-within-domain,
  // then company. Converges after one pass — rows with nothing to key on are
  // excluded by the WHERE rather than being retried on every cold start.
  `UPDATE leads SET contact_key =
     CASE
       WHEN email IS NOT NULL AND trim(email) != ''
         THEN 'email:' || lower(trim(email))
       WHEN person_name IS NOT NULL AND trim(person_name) != ''
         THEN 'person:' || lower(coalesce(
                CASE WHEN domain LIKE 'www.%' THEN substr(domain, 5) ELSE domain END, ''))
              || ':' || lower(trim(person_name))
       ELSE 'company:' ||
              lower(CASE WHEN domain LIKE 'www.%' THEN substr(domain, 5) ELSE domain END)
     END
   WHERE contact_key IS NULL
     AND ( (email IS NOT NULL AND trim(email) != '')
        OR (person_name IS NOT NULL AND trim(person_name) != '')
        OR (domain IS NOT NULL AND trim(domain) != '') )`,
];

export function isRemote(): boolean {
  return Boolean(process.env.TURSO_DATABASE_URL);
}

/**
 * True when running on a serverless host with no hosted database configured.
 * Everything still works, but the file lives in the function's own /tmp: it is
 * not shared between concurrent invocations and is wiped on every cold start.
 * The UI says so rather than letting data appear to vanish at random.
 */
export function isEphemeral(): boolean {
  return !isRemote() && Boolean(process.env.VERCEL);
}

export async function db(): Promise<Client> {
  if (client) return client;
  if (ready) return ready;

  ready = (async () => {
    let pending: Client;
    if (isRemote()) {
      pending = createClient({
        url: process.env.TURSO_DATABASE_URL!,
        authToken: process.env.TURSO_AUTH_TOKEN,
      });
    } else {
      // Only /tmp is writable on a serverless filesystem.
      const path = isEphemeral() ? "/tmp/juniper.db" : LOCAL_PATH;
      mkdirSync(dirname(path), { recursive: true });
      pending = createClient({ url: `file:${path}` });
    }

    try {
      for (const stmt of SCHEMA) await pending.execute(stmt);
      for (const stmt of MIGRATIONS) {
        try {
          await pending.execute(stmt);
        } catch (err) {
          if (!/duplicate column name/i.test(String(err))) throw err;
        }
      }
    } catch (err) {
      // Let the next caller retry instead of caching a broken connection.
      ready = null;
      throw err;
    }

    // Publish only once the schema exists. Assigning `client` any earlier lets
    // a concurrent caller take the `if (client)` fast path and query tables
    // that have not been created yet — which is exactly what a page issuing
    // two queries in parallel does on a cold database.
    client = pending;
    return pending;
  })();

  return ready;
}

export const now = () => new Date().toISOString();

type Row = Record<string, unknown>;

const str = (v: unknown) => String(v);
const nstr = (v: unknown) => (v === null || v === undefined ? null : String(v));
const num = (v: unknown) => Number(v);
const nnum = (v: unknown) => (v === null || v === undefined ? null : Number(v));

/** libsql rows are array-like; rebuild them as plain objects for React. */
async function query(sql: string, args: InValue[] = []): Promise<Row[]> {
  const res = await (await db()).execute({ sql, args });
  return res.rows.map((r) => ({ ...r }) as Row);
}

async function run(sql: string, args: InValue[] = []) {
  return (await db()).execute({ sql, args });
}

// ---------------------------------------------------------------- profile

export interface Icp {
  segments: string[];
  companySizes: string[];
  industries: string[];
  buyerTitles: string[];
  painPoints: string[];
  disqualifiers: string[];
  /** Search terms handed to the keyword-driven signal providers. */
  watchTerms: string[];
}

export interface Profile {
  website: string;
  companyName: string;
  valueProp: string;
  icp: Icp;
  updatedAt: string;
}

export async function getProfile(): Promise<Profile | null> {
  const rows = await query("SELECT * FROM profile WHERE id = 1");
  if (rows.length === 0) return null;
  const r = rows[0];
  return {
    website: str(r.website),
    companyName: str(r.company_name),
    valueProp: str(r.value_prop),
    icp: JSON.parse(str(r.icp_json)) as Icp,
    updatedAt: str(r.updated_at),
  };
}

export async function saveProfile(p: Omit<Profile, "updatedAt">): Promise<Profile> {
  await run(
    `INSERT INTO profile (id, website, company_name, value_prop, icp_json, updated_at)
     VALUES (1, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       website = excluded.website,
       company_name = excluded.company_name,
       value_prop = excluded.value_prop,
       icp_json = excluded.icp_json,
       updated_at = excluded.updated_at`,
    [p.website, p.companyName, p.valueProp, JSON.stringify(p.icp), now()],
  );
  return (await getProfile())!;
}

// -------------------------------------------------------------- watchlist

export interface WatchlistEntry {
  id: number;
  provider: string;
  handle: string;
  label: string;
  domain: string | null;
}

export async function listWatchlist(): Promise<WatchlistEntry[]> {
  const rows = await query("SELECT * FROM watchlist ORDER BY provider, label");
  return rows.map((r) => ({
    id: num(r.id),
    provider: str(r.provider),
    handle: str(r.handle),
    label: str(r.label),
    domain: nstr(r.domain),
  }));
}

export async function addWatchlistEntry(e: Omit<WatchlistEntry, "id">): Promise<void> {
  await run(
    `INSERT INTO watchlist (provider, handle, label, domain) VALUES (?, ?, ?, ?)
     ON CONFLICT(provider, handle) DO UPDATE SET
       label = excluded.label, domain = excluded.domain`,
    [e.provider, e.handle, e.label, e.domain],
  );
}

export async function removeWatchlistEntry(id: number): Promise<void> {
  await run("DELETE FROM watchlist WHERE id = ?", [id]);
}

// ------------------------------------------------------------ suppressions

/**
 * The "never contact these" list — customers, competitors, partners, anyone who
 * asked to be left alone. Consulted by the contact gate before a sequence is
 * written, so an entry added today stops tomorrow's run cold.
 */
export async function listSuppressions(): Promise<Suppression[]> {
  const rows = await query("SELECT * FROM suppressions ORDER BY kind, value");
  return rows.map((r) => ({
    id: num(r.id),
    kind: str(r.kind) as SuppressionKind,
    value: str(r.value),
    reason: str(r.reason),
    createdAt: str(r.created_at),
  }));
}

export async function addSuppression(
  kind: SuppressionKind,
  value: string,
  reason: string,
): Promise<void> {
  await run(
    `INSERT INTO suppressions (kind, value, reason, created_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(kind, value) DO UPDATE SET reason = excluded.reason`,
    [kind, normaliseSuppression(kind, value), reason, now()],
  );
}

export async function removeSuppression(id: number): Promise<void> {
  await run("DELETE FROM suppressions WHERE id = ?", [id]);
}

export { query, run, str, nstr, num, nnum };
