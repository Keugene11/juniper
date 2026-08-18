# Juniper

A signal-based B2B prospecting tool — a working clone of the Gojiberry AI category.

The premise: don't buy a list and mail it. Watch for **events** that indicate a
company is in-market right now, filter those events against your ICP, and write
outreach that references the specific event. The trigger is the differentiator;
everything else is plumbing around it.

## The pipeline

Five stages. Each one is a filter, so the expensive stages only ever see what
survived the cheap ones.

| # | Stage | What happens | Cost |
|---|-------|--------------|------|
| 1 | **Onboard** | Paste your URL. Juniper crawls `/`, `/about`, `/product`, `/pricing`, `/customers`, `/solutions`, strips them to text, and has Claude reverse-engineer what you sell, who buys it, and which public phrases to watch for. | 1 model call, once |
| 2 | **Ingest** | Every enabled provider runs concurrently and normalises what it finds into a single `Signal` shape. Duplicates are rejected on a stable `dedupeKey`, and trigger types you did not select are dropped before anything is persisted. | free |
| 3 | **Score** | Intent comes from the signal taxonomy and the event's age (deterministic, no model call). ICP fit needs judgement, so it goes to Claude — batched 25 signals per call. `total = 0.6·fit + 0.4·intent`. | 1 call / 25 signals |
| 4 | **Enrich** | Email waterfall over the survivors above your score threshold. | 1 lookup / lead |
| 5 | **Write** | A three-step sequence per lead, conditioned on that lead's specific trigger event. | 1 call / lead |

Nothing is sent, so the sixth stage is a human one: mark on the Leads tab what
actually happened, and the Activity tab reports reply rate per trigger type.

## Trigger taxonomy and intent decay

Eleven event types, each with a peak intent weight and a half-life:

| Trigger | Peak | Half-life | Sourced from |
|---------|-----:|----------:|--------------|
| Competitor complaint | 96 | 7d | Reddit, Hacker News, simulator |
| Competitor engagement | 95 | 5d | Unipile, simulator |
| Pain point mentioned | 90 | 10d | Reddit, Hacker News, simulator |
| Event attendance | 85 | 2d | simulator |
| Hiring spike | 80 | 30d | Greenhouse, Lever, Ashby |
| Funding round | 75 | 30d | Crunchbase, Hacker News, simulator |
| Job change | 70 | 30d | simulator |
| Tech stack change | 65 | 45d | Reddit, Hacker News, simulator |
| Product launch | 55 | 21d | Reddit, Hacker News |
| New role opened | 50 | 21d | Greenhouse, Lever, Ashby |
| Media mention | 40 | 14d | Hacker News |

A signal is a window, not a fact. Intent is `peak · 2^(-age / half-life)`,
floored at 10% of peak, measured from the event's own timestamp (`occurredAt`)
rather than from when Juniper happened to scrape it. A webinar RSVP is worth 85
today, 60 tomorrow, and nothing by the weekend; a Series B still funds purchases
a quarter later. Without this, a six-month-old forum post outranks a complaint
posted this morning because it matched more keywords — which is how
signal-based prospecting quietly degrades back into list-buying.

Every provider must map its source's own date onto `occurredAt`; `pnpm verify`
reports the share of each provider's signals that carry one, because a provider
that leaves it null looks permanently fresh and silently opts that whole source
out of decay.

The score on a card is the score at ingestion time. The freshness tag next to it
is recomputed on every read, so a lead visibly cools while it sits in the list.

## Quick start

```bash
pnpm install
cp .env.example .env      # add ANTHROPIC_API_KEY
node scripts/seed.ts      # optional: demo profile + watchlist
pnpm dev
```

Then open the app, go to **Setup**, paste your website, and hit **Analyse**.
Add a few companies to the watchlist, then **Run pipeline** on the Signals tab.

Without an Anthropic key, ingestion still works and persists signals — stages 1,
3, and 5 return a clear error instead of failing silently.

## Signal sources

Real, watchlist-driven:

- **Greenhouse** — public job-board JSON. 5+ roles opened in 45 days is a
  hiring spike; fewer are individual role signals. (Verified live: Figma 161
  roles, GitLab 195.)
- **Lever** — same logic against the public postings API.
- **Ashby** — same logic again, and the one worth adding: ATS choice tracks
  company age, so a Greenhouse-and-Lever-only watchlist is blind to much of the
  last five years of founding. Every posting carries a true `publishedAt`, so
  "opened recently" means the role rather than the record. (Verified live: Ramp
  136 roles.)

Real, keyword-driven:

- **Hacker News** — relevance-ranked Algolia search over the last 180 days,
  using the watch terms inferred from your site. Best for developer-tool and
  infrastructure ICPs; it will be quiet for most other categories, and quiet is
  the correct answer rather than noise.

Synthetic:

- **Simulator** — seeded on the day, so re-running is idempotent. It exists to
  cover the *person-level* signal types no public API exposes (competitor
  engagement, job changes) so stages 3–5 can be exercised end to end. Its
  companies are not real; it says so in its own run warnings.

Real, credential-gated. These stay listed on the Setup tab when unconfigured and
name the variable they want, because a source that silently vanished would be
indistinguishable from one that ran and found nothing:

- **Reddit** (`REDDIT_CLIENT_ID` / `REDDIT_CLIENT_SECRET`) — the official OAuth
  Data API, and the best public source for the competitor-complaint signal. Note
  the two doors: `robots.txt` is `Disallow: /` for every user-agent and the
  unauthenticated `search.json` view answers 403, but that governs *crawling the
  website* — the OAuth API answers 401 for bad credentials because it expects
  you to have registered. **The free tier is non-commercial use only** (personal
  projects, research); commercial use needs Reddit's written approval and a paid
  agreement. If you are selling this, leave the variables unset. Reddit posts
  carry no company domain, so these leads skip the email waterfall by design —
  you reply in the thread.
- **Crunchbase** (`CRUNCHBASE_API_KEY`) — funding rounds closed in the last 30
  days, the real source for a trigger the simulator used to fake. Not
  watchlist-driven, because you cannot know in advance who is about to raise: it
  pulls the window and lets ICP scoring discard what you cannot sell to. That
  spends more scoring budget per useful lead than the job boards do, so keep the
  per-provider limit modest. Paid — their free tier was withdrawn.
- **Unipile** (`UNIPILE_DSN` / `UNIPILE_API_KEY`) — LinkedIn reactions and
  comments on posts you watch, through an account *you* connect. Watchlist
  handles are LinkedIn post ids rather than board slugs. See the note below on
  why this exists next to the LinkedIn stub. Written against Unipile's published
  API reference but not yet exercised against a live tenant.

Not implemented:

- **Google News RSS** — works, and returns real funding coverage, but is served
  under a notice restricting it to personal, non-commercial feed readers.
  Funding and press therefore come from Crunchbase and Hacker News only.
- **LinkedIn** — a documented stub. It is the highest-value source in this
  category and the reason the commercial tools work as well as they do, but
  collecting it means scraping: that violates the LinkedIn User Agreement, and
  sending sequences from a personal account risks permanent restriction of the
  account. `src/lib/signals/linkedin.ts` explains what to implement if you have
  partner API access — the rest of the pipeline needs no changes, because every
  provider normalises to the same `Signal` shape.

### Scraping vs. account-based access

The `linkedin` stub refuses to scrape and that refusal stands; the `unipile`
provider is a different thing, and the difference is the one LinkedIn's
litigation has actually turned on.

Proxycurl was sued in January 2025 and shut down that July — at $10M ARR — for
operating hundreds of thousands of fake accounts, scraping profiles into its own
database, and reselling that database. An account-based API has neither half:
there is no vendor-run account pool and no shared dataset, and nothing is
collected that your own logged-in session could not already see.

It is still automated access, which the LinkedIn User Agreement prohibits, and
the account carrying that risk is your professional identity rather than a
vendor's balance sheet. That is a risk transfer, not a loophole. Enable it
knowingly or not at all.

### Relevance gating

Algolia and Reddit search both match with loose OR semantics, so a query for
`CRM data hygiene` cheerfully returns anything containing "data". Left unchecked
that fabricates signals and spends real money scoring them. Every hit is
re-checked locally in `signals/relevance.ts`: **all** of the term's content words
must appear, and at least one must appear in the *title*. On a revops ICP this
cut 9 hits to 1 genuine one; on a developer-tool ICP it keeps 21.

## Email waterfall

Providers are tried in order until one returns an address:

1. **Hunter** — needs `HUNTER_API_KEY`
2. **Apollo** — needs `APOLLO_API_KEY`
3. **pattern+mx** — always available. Builds `first.last@domain` and confirms
   the domain accepts mail via MX lookup, falling back to DNS-over-HTTPS when
   port 53 is blocked (common in containers and on corporate networks).

Confidence is graded honestly: 55% when MX resolves, 30% when verification was
unavailable, and no address at all when the domain provably takes no mail. The
full attempt trail is kept on every result. Note that MX verifies the *domain*,
not the mailbox.

## Outbound destinations

Where a finished lead goes. Configured with env vars, shown on the Setup tab:

| Target | Needs | Does |
|--------|-------|------|
| Slack | `SLACK_WEBHOOK_URL` | One Block Kit message per lead, trigger quoted, link to source |
| Webhook | `JUNIPER_WEBHOOK_URL` | POSTs the `LeadView` as-is — Zapier, n8n, Make, anything internal. Optional `JUNIPER_WEBHOOK_SECRET` becomes a bearer token so the receiver can reject everything else |
| HubSpot | `HUBSPOT_ACCESS_TOKEN` | Creates a contact with `juniper_signal_kind`, `juniper_signal_evidence`, `juniper_total_score` custom properties |
| Pipedrive | `PIPEDRIVE_API_TOKEN` | Creates a person, then a lead titled after the trigger |

This is shaped like the email waterfall with one deliberate difference: the
waterfall stops at the first success because it only wants *an* address, while
this fans out to every configured destination, because Slack and a CRM are not
alternatives to each other. Each target reports its own outcome and one failing
never stops the others — a run where Slack posts and HubSpot rejects a missing
custom property is the normal case, and both results are kept on the lead.

The trigger travels with the record. A CRM contact without the event that
produced it is just another name, and whoever works it has nothing to open with.

Pushing is **manual by default** — a button on the lead card — because a push
writes into systems other people are looking at, and nobody should discover that
by running the pipeline for the first time. Set `JUNIPER_AUTO_PUSH=1` to push
during a run instead.

## Outcomes and the Activity tab

Juniper never sends anything, so it cannot observe what happened — you record it.
Each lead card has an outcome control (contacted / replied / meeting / lost), and
the **Activity** tab turns those into the only number that matters:

- **Funnel** — signals → scored → passed ICP → address found → sequenced →
  contacted → replied → meeting. Every drop is a filter doing its job.
- **Trigger performance** — reply rate per trigger type, printed next to the
  intent weight the taxonomy assumes. When a trigger weighted 95 has produced
  twenty contacts and no replies, the weight is wrong *for your ICP*: deselect
  it on the next run rather than treating the constant as fact.
- **Source quality** — share of each provider's scored signals that survived ICP
  filtering. Volume with no qualified leads means scoring calls spent for
  nothing; tighten the watch terms rather than raising the limit.
- **Recent runs** — counts, duration, and whether the run finished, failed, or
  was killed mid-flight.

## Scheduled runs

`GET /api/cron/run` runs the same pipeline unattended, which is all "agents that
run 24/7" amounts to. `vercel.json` schedules it daily; Vercel Cron authenticates
with `CRON_SECRET` as a bearer token.

With `CRON_SECRET` unset the endpoint answers 503 rather than defaulting to open
— an unauthenticated caller here would spend model credits on demand, which is a
worse failure than a cron job that never fires. Unattended runs are also
stingier than the button (threshold 70, three leads), tunable with
`JUNIPER_CRON_THRESHOLD` and `JUNIPER_CRON_MAX_OUTREACH`.

## Adding a signal provider

Implement `SignalProvider` in `src/lib/signals/` and add it to `PROVIDERS` in
`registry.ts`. Return `{ signals, warnings }` — put per-target failures in
`warnings` rather than swallowing them, so an empty feed is never mistaken for
"there was nothing to find". `collectSignals` scopes the watchlist to your
provider id automatically.

Three things are easy to get wrong:

- Declare the `kinds` you can actually emit — the trigger picker is built from
  them, and only from providers that are enabled *and* configured.
- Map your source's own timestamp onto `occurredAt`. Leave it null and your
  signals look permanently fresh, which opts that whole source out of decay.
- List every env var you need in `requires`. The registry uses it to skip you
  with a warning that names the missing variable, instead of letting you fail on
  the first request.

## Deployment

Live at **https://juniper-eight.vercel.app** (repo:
`github.com/Keugene11/juniper`, Vercel project `keugenes-projects/juniper`).
Pushes to `master` deploy automatically.

Two environment variables are needed before it is fully functional:

```bash
# Unlocks ICP inference, lead scoring, and message generation.
vercel env add ANTHROPIC_API_KEY production

# Persistent storage. Without these the deployment writes to the function's
# own /tmp: not shared between concurrent requests, wiped on every cold start.
vercel env add TURSO_DATABASE_URL production
vercel env add TURSO_AUTH_TOKEN production

# Optional: enables the daily scheduled run in vercel.json.
vercel env add CRON_SECRET production
```

Schema changes ship as `ALTER TABLE` statements in `MIGRATIONS` (`src/lib/db.ts`)
because `CREATE TABLE IF NOT EXISTS` is a no-op against a live database. They run
on first connection and swallow only the duplicate-column error.

To create the database (requires a browser login, so run it yourself):

```bash
irm get.tur.so/install.ps1 | iex     # Windows; or: brew install tursodatabase/tap/turso
turso auth signup
turso db create juniper
turso db show juniper --url          # -> TURSO_DATABASE_URL
turso db tokens create juniper       # -> TURSO_AUTH_TOKEN
```

Then `vercel deploy --prod` to pick up the new variables. The schema creates
itself on first connection.

`maxDuration` on `/api/pipeline/run` is 60s, the Hobby ceiling. `runPipeline`
keeps its own budget (`JUNIPER_RUN_BUDGET_MS`, default 50s) just under it and
stops early rather than being killed mid-lead — a kill would leave a lead
enriched with no copy written. On Pro, raise both together.

## Environment notes

**TLS interception.** If your network runs an HTTPS-inspecting proxy, Node
rejects every outbound call with `UNABLE_TO_VERIFY_LEAF_SIGNATURE`, because it
ships its own root list and ignores the OS one. `scripts/run-next.mjs` adds
`--use-system-ca`, which *adds* the system roots to Node's set — it does not
disable verification. Opt out with `JUNIPER_SKIP_SYSTEM_CA=1`. Never reach for
`NODE_TLS_REJECT_UNAUTHORIZED=0`.

**Blocked DNS.** If both port 53 and DNS-over-HTTPS are unreachable, MX
verification degrades to 30%-confidence guesses rather than returning nothing.

## Stack

Next.js 15 (App Router) · TypeScript · Tailwind v4 · libsql (`@libsql/client`)
so the same schema runs against a local file in dev and hosted Turso in
production · Claude Opus 5 via `@anthropic-ai/sdk`.

All three model-backed stages use structured outputs (`output_config.format`),
so responses are schema-valid JSON — no regex extraction, no retry-on-parse.
Server-side refusal fallbacks are enabled by default: if a classifier declines a
request, it is re-run on Anthropic's recommended substitute inside the same
call rather than surfacing as an error.

## Scripts

| Command | Purpose |
|---------|---------|
| `pnpm dev` / `build` / `start` | Next, with the system CA store trusted |
| `pnpm typecheck` | `tsc --noEmit` |
| `node scripts/seed.ts` | Demo profile + watchlist, no API key needed |
| `pnpm verify` | Exercises every non-AI stage against the live upstreams |

## Limits

- **Nothing is ever sent.** Sequences are drafts. Wire a sending provider
  before enabling delivery, and read up on CAN-SPAM/GDPR before you do.
- Scoring quality is bounded by ICP quality. Re-run the website analysis after
  editing your positioning.
- The Greenhouse, Lever, and Ashby providers need board handles; there is no
  public index of which companies use them, which is why the watchlist is manual.
- Reply rates on the Activity tab are only as good as the outcomes you record.
  Sequences you send and never mark contacted look, to the report, like leads you
  never worked.
- The Unipile provider is written against the published API reference but has
  not been run against a live tenant. If it returns items that map to nothing,
  it says so in its warnings rather than reporting an empty feed.
- Intent half-lives are defaults, not measurements. They are one constant per
  trigger in `src/lib/signals/types.ts`; the Activity tab is what tells you
  whether yours are wrong.
