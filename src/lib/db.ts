import { neon, type NeonQueryFunction } from "@neondatabase/serverless";
import {
  normaliseSuppression,
  type Suppression,
  type SuppressionKind,
} from "./contacts";

/**
 * Storage is Postgres, reached over Neon's HTTP driver rather than a socket:
 * serverless invocations are short and unpooled, so a per-request TCP handshake
 * to a normal Postgres would cost more than the queries do.
 *
 * Set DATABASE_URL (Vercel's Neon integration also sets POSTGRES_URL). There is
 * no local-file fallback — unlike SQLite there is no such thing as an embedded
 * Postgres, so an unset URL is a configuration error rather than a degraded
 * mode, and it says so on the first query instead of pretending to work.
 */
let client: NeonQueryFunction<false, true> | null = null;
let ready: Promise<NeonQueryFunction<false, true>> | null = null;

function connectionString(): string | undefined {
  return process.env.DATABASE_URL || process.env.POSTGRES_URL;
}

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
    id       INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    provider TEXT NOT NULL,
    handle   TEXT NOT NULL,
    label    TEXT NOT NULL,
    domain   TEXT,
    UNIQUE (provider, handle)
  )`,
  `CREATE TABLE IF NOT EXISTS signals (
    id           INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
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
    id               INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
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
    id           INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
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
    id         INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    kind       TEXT NOT NULL,
    value      TEXT NOT NULL,
    reason     TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    UNIQUE (kind, value)
  )`,
  `CREATE TABLE IF NOT EXISTS runs (
    id          INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
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
 * deployment against a live database would silently keep the old shape and fail
 * on first query. Postgres has `ADD COLUMN IF NOT EXISTS`, so unlike the SQLite
 * original these are honestly idempotent rather than leaning on a swallowed
 * duplicate-column error.
 */
const MIGRATIONS = [
  `ALTER TABLE signals ADD COLUMN IF NOT EXISTS occurred_at TEXT`,
  `ALTER TABLE leads ADD COLUMN IF NOT EXISTS outcome TEXT NOT NULL DEFAULT 'none'`,
  `ALTER TABLE leads ADD COLUMN IF NOT EXISTS outcome_at TEXT`,
  `ALTER TABLE leads ADD COLUMN IF NOT EXISTS pushed_at TEXT`,
  `ALTER TABLE leads ADD COLUMN IF NOT EXISTS push_result TEXT`,
  `ALTER TABLE leads ADD COLUMN IF NOT EXISTS contact_key TEXT`,
  `ALTER TABLE leads ADD COLUMN IF NOT EXISTS skip_reason TEXT`,
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
  return Boolean(connectionString());
}

/**
 * True when no database is configured at all. Nothing works in that state, so
 * the UI names the missing variable rather than surfacing a connection error
 * from whichever query happened to run first.
 */
export function isUnconfigured(): boolean {
  return !isRemote();
}

/**
 * Two concurrent cold starts can run the initialiser at the same time, and
 * Postgres resolves that race by failing one of them: `CREATE TABLE IF NOT
 * EXISTS` still reaches for the same catalog rows, so the loser can see a
 * duplicate-object or unique-violation error rather than a no-op. Both are
 * benign here — the object exists either way, which is all the caller wanted.
 */
function isBenignRace(err: unknown): boolean {
  const code = (err as { code?: string })?.code;
  if (code === "42P07" || code === "42710" || code === "23505") return true;
  return /already exists|duplicate key value/i.test(String(err));
}

export async function db(): Promise<NeonQueryFunction<false, true>> {
  if (client) return client;
  if (ready) return ready;

  ready = (async () => {
    const url = connectionString();
    if (!url) {
      ready = null;
      throw new Error(
        "No database configured. Set DATABASE_URL to a Neon Postgres connection " +
          "string (see README, Deployment).",
      );
    }

    const pending = neon(url, { fullResults: true });

    try {
      for (const stmt of [...SCHEMA, ...MIGRATIONS]) {
        try {
          await pending.query(stmt);
        } catch (err) {
          if (!isBenignRace(err)) throw err;
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

/**
 * Every call site writes `?` placeholders, which is what SQLite took and what
 * this codebase is written in; Postgres wants `$1`, `$2`. Rewriting ~50 query
 * strings by hand would have been ~50 chances to misnumber one, so the
 * translation lives here instead, where it is one function to get right.
 *
 * Quoted literals, line comments and block comments are all skipped so a `?`
 * inside any of them is left alone — the schema in this very file carries block
 * comments, so that is a real shape rather than a hypothetical. Postgres
 * doubles single quotes to escape them, and toggling twice on `''` lands in the
 * same state, so that case needs no special handling.
 */
function toPositional(sql: string): string {
  let out = "";
  let n = 0;
  let inString = false;
  let inLine = false;
  let inBlock = false;

  for (let i = 0; i < sql.length; i++) {
    const c = sql[i];

    if (inLine) {
      out += c;
      if (c === "\n") inLine = false;
      continue;
    }
    if (inBlock) {
      out += c;
      if (c === "*" && sql[i + 1] === "/") {
        out += "/";
        i++;
        inBlock = false;
      }
      continue;
    }
    if (!inString && c === "-" && sql[i + 1] === "-") {
      inLine = true;
      out += c;
      continue;
    }
    if (!inString && c === "/" && sql[i + 1] === "*") {
      inBlock = true;
      out += "/*";
      i++;
      continue;
    }
    if (c === "'") {
      inString = !inString;
      out += c;
      continue;
    }
    if (c === "?" && !inString) {
      out += `$${++n}`;
      continue;
    }
    out += c;
  }
  return out;
}

/** `undefined` is not a wire value; the columns that receive it are nullable. */
const toParams = (args: readonly unknown[]) =>
  args.map((a) => (a === undefined ? null : a));

async function query(sql: string, args: readonly unknown[] = []): Promise<Row[]> {
  const res = await (await db()).query(toPositional(sql), toParams(args));
  return res.rows as Row[];
}

/**
 * Mirrors the shape the libsql driver returned, so the call sites that ask
 * "did this change anything?" read exactly as they did before.
 */
async function run(
  sql: string,
  args: readonly unknown[] = [],
): Promise<{ rowsAffected: number; rows: Row[] }> {
  const res = await (await db()).query(toPositional(sql), toParams(args));
  return { rowsAffected: res.rowCount ?? 0, rows: res.rows as Row[] };
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

export { query, run, str, nstr, num, nnum, toPositional };
