import { NextResponse } from "next/server";
import { enrichmentProviderStatus } from "@/lib/enrichment";
import { outboundTargetStatus } from "@/lib/outbound";
import { collectableKinds, providerStatus } from "@/lib/signals/registry";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json({
    signalProviders: providerStatus(),
    collectableKinds: collectableKinds(),
    enrichmentProviders: enrichmentProviderStatus(),
    outboundTargets: outboundTargetStatus(),
  });
}
