import { NextResponse } from "next/server";
import { describeAiError } from "@/lib/claude";
import { runPipeline, type RunOptions } from "@/lib/pipeline";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// 60s is the Hobby ceiling; Pro allows more. `runPipeline` keeps its own
// wall-clock budget just under this (JUNIPER_RUN_BUDGET_MS) and stops early
// rather than being killed mid-lead, which would leave a lead enriched but
// with no copy written. Raise both together on a paid plan.
export const maxDuration = 60;

export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as RunOptions;

  try {
    const stats = await runPipeline({
      providers: Array.isArray(body.providers) ? body.providers : undefined,
      threshold: clampNum(body.threshold, 0, 100, 60),
      maxOutreach: clampNum(body.maxOutreach, 1, 25, 4),
      perProviderLimit: clampNum(body.perProviderLimit, 1, 40, 12),
      channel: body.channel === "linkedin" ? "linkedin" : "email",
    });
    return NextResponse.json({ stats });
  } catch (err) {
    const { status, message } = describeAiError(err);
    return NextResponse.json({ error: message }, { status });
  }
}

function clampNum(v: unknown, min: number, max: number, fallback: number): number {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.round(n)));
}
