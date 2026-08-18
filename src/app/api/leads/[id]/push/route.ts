import { NextResponse } from "next/server";
import { outboundConfigured } from "@/lib/outbound";
import { pushLeadById } from "@/lib/pipeline";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Sends one lead to every configured outbound destination.
 *
 * Always 200 when the lead exists, even if every destination failed — the
 * per-target outcomes are the payload, and collapsing four independent results
 * into one status code would hide which of them worked.
 */
export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const leadId = Number(id);
  if (!Number.isInteger(leadId) || leadId <= 0) {
    return NextResponse.json({ error: "Invalid lead id." }, { status: 400 });
  }

  if (!outboundConfigured()) {
    return NextResponse.json(
      {
        error:
          "No outbound destination configured. Set SLACK_WEBHOOK_URL, JUNIPER_WEBHOOK_URL, HUBSPOT_ACCESS_TOKEN, or PIPEDRIVE_API_TOKEN.",
      },
      { status: 400 },
    );
  }

  const outcomes = await pushLeadById(leadId);
  if (!outcomes) return NextResponse.json({ error: "No such lead." }, { status: 404 });

  return NextResponse.json({ id: leadId, outcomes });
}
