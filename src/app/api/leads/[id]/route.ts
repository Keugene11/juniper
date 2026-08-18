import { NextResponse } from "next/server";
import { isLeadOutcome, setLeadOutcome } from "@/lib/pipeline";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Records what happened after outreach. Juniper never sends anything, so the
 * outcome cannot be observed — it is reported by the person who did send, and
 * it is the only input the analytics tab has for measuring which trigger types
 * actually convert.
 */
export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const leadId = Number(id);
  if (!Number.isInteger(leadId) || leadId <= 0) {
    return NextResponse.json({ error: "Invalid lead id." }, { status: 400 });
  }

  const body = (await req.json().catch(() => ({}))) as { outcome?: unknown };
  if (!isLeadOutcome(body.outcome)) {
    return NextResponse.json(
      { error: "outcome must be one of: none, contacted, replied, meeting, lost." },
      { status: 400 },
    );
  }

  const updated = await setLeadOutcome(leadId, body.outcome);
  if (!updated) return NextResponse.json({ error: "No such lead." }, { status: 404 });

  return NextResponse.json({ id: leadId, outcome: body.outcome });
}
