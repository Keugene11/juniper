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
| 2 | **Ingest** | Every enabled provider runs concurrently and normalises what it finds into a single `Signal` shape. Duplicates are rejected on a stable `dedupeKey`. | free |
| 3 | **Score** | Intent comes from the signal taxonomy (deterministic, no model call). ICP fit needs judgement, so it goes to Claude — batched 25 signals per call. `total = 0.6·fit + 0.4·intent`. | 1 call / 25 signals |
| 4 | **Enrich** | Email waterfall over the survivors above your score threshold. | 1 lookup / lead |
| 5 | **Write** | A three-step sequence per lead, conditioned on that lead's specific trigger event. | 1 call / lead |

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

Not implemented:

- **LinkedIn** — a documented stub. It is the highest-value source in this
  category and the reason the commercial tools work as well as they do, but
  collecting it means scraping: that violates the LinkedIn User Agreement, and
  sending sequences from a personal account risks permanent restriction of the
  account. `src/lib/signals/linkedin.ts` explains what to implement if you have
  partner API access — the rest of the pipeline needs no changes, because every
  provider normalises to the same `Signal` shape.

### Relevance gating

Algolia matches with loose OR semantics, so a query for `CRM data hygiene`
cheerfully returns a story that merely contains "data". Left unchecked that
fabricates signals and spends real money scoring them. Every hit is re-checked
locally: **all** of the term's content words must appear, and at least one must
appear in the *title*. On a revops ICP this cut 9 hits to 1 genuine one; on a
developer-tool ICP it keeps 21.

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

## Adding a signal provider

Implement `SignalProvider` in `src/lib/signals/` and add it to `PROVIDERS` in
`registry.ts`. Return `{ signals, warnings }` — put per-target failures in
`warnings` rather than swallowing them, so an empty feed is never mistaken for
"there was nothing to find". `collectSignals` scopes the watchlist to your
provider id automatically.

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

Next.js 15 (App Router) · TypeScript · Tailwind v4 · `node:sqlite` (Node 24
built-in, so there is no native module to compile) · Claude Opus 5 via
`@anthropic-ai/sdk`.

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
- The Greenhouse and Lever providers need board handles; there is no public
  index of which companies use them, which is why the watchlist is manual.
