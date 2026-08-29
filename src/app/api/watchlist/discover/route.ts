import { NextResponse } from "next/server";
import { describeAiError } from "@/lib/claude";
import { addWatchlistEntry, clearWatchlist, getProfile, listWatchlist } from "@/lib/db";
import { discoverCompanies } from "@/lib/discovery";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

/**
 * Rebuilds the watchlist from the saved ICP.
 *
 * Kept off `/api/profile` on purpose: analysing a site is already a crawl plus
 * a model call, and bundling a second model call and up to three board probes
 * per candidate into the same request would put it well past the serverless
 * time budget. The client calls this straight after a successful analysis
 * instead, so each request stays inside its own ceiling and the user sees the
 * two stages report separately.
 *
 * `replace: true` clears first — a new target means new prospects. The manual
 * button on the Setup tab passes false, which tops the list up instead.
 */
export async function POST(req: Request) {
  const body = (await req.json().catch(() => null)) as {
    replace?: boolean;
    limit?: number;
  } | null;

  const profile = await getProfile();
  if (!profile) {
    return NextResponse.json(
      { error: "No targeting profile yet. Analyse your website first." },
      { status: 400 },
    );
  }

  try {
    const { companies, rejected } = await discoverCompanies(profile, {
      limit: body?.limit,
    });

    // Cleared only after discovery succeeds. Clearing first would leave the
    // watchlist empty if the model call failed, which is strictly worse than
    // the stale list it replaced.
    if (body?.replace) await clearWatchlist();

    for (const c of companies) {
      await addWatchlistEntry({
        provider: c.provider,
        handle: c.handle,
        label: c.name,
        domain: c.domain,
      });
    }

    return NextResponse.json({
      watchlist: await listWatchlist(),
      added: companies,
      rejected,
    });
  } catch (err) {
    const { status, message } = describeAiError(err);
    return NextResponse.json({ error: message }, { status });
  }
}
