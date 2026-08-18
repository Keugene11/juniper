import { NextResponse } from "next/server";
import { describeAiError } from "@/lib/claude";
import { MissingProfileError, runPipeline } from "@/lib/pipeline";
import { parseKinds } from "@/lib/signals/registry";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Unattended run, for a scheduler. The commercial tools in this category sell
 * "agents that run 24/7", which in practice means exactly this: the same
 * pipeline on a timer instead of a button.
 *
 * Guarded by CRON_SECRET, which Vercel Cron sends as a bearer token. With the
 * variable unset the endpoint refuses rather than defaulting to open: an
 * unauthenticated caller here would spend model credits on demand, which is a
 * worse failure than a cron job that does not fire.
 */
export async function GET(req: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    return NextResponse.json(
      { error: "CRON_SECRET is not set — scheduled runs are disabled." },
      { status: 503 },
    );
  }
  if (req.headers.get("authorization") !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }

  // Scheduled runs are deliberately more conservative than the button: nobody
  // is watching, so cap the per-run spend and only write copy for leads that
  // clear a higher bar.
  const { searchParams } = new URL(req.url);
  try {
    const stats = await runPipeline({
      threshold: Number(process.env.JUNIPER_CRON_THRESHOLD ?? 70),
      maxOutreach: Number(process.env.JUNIPER_CRON_MAX_OUTREACH ?? 3),
      kinds: parseKinds(searchParams.get("kinds")?.split(",")),
    });
    return NextResponse.json({ stats });
  } catch (err) {
    if (err instanceof MissingProfileError) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
    const { status, message } = describeAiError(err);
    return NextResponse.json({ error: message }, { status });
  }
}
