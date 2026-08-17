import { NextResponse } from "next/server";
import { enrichmentProviderStatus } from "@/lib/enrichment";
import { PROVIDERS } from "@/lib/signals/registry";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json({
    signalProviders: PROVIDERS.map(({ id, label, description, enabled }) => ({
      id,
      label,
      description,
      enabled,
    })),
    enrichmentProviders: enrichmentProviderStatus(),
  });
}
