import { NextResponse } from "next/server";
import { addWatchlistEntry, listWatchlist, removeWatchlistEntry } from "@/lib/db";
import { getProvider } from "@/lib/signals/registry";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json({ watchlist: await listWatchlist() });
}


export async function POST(req: Request) {
  const body = (await req.json().catch(() => null)) as {
    provider?: string;
    handle?: string;
    label?: string;
    domain?: string;
  } | null;

  if (!body?.provider || !body.handle?.trim() || !body.label?.trim()) {
    return NextResponse.json(
      { error: "provider, handle, and label are all required." },
      { status: 400 },
    );
  }
  if (!getProvider(body.provider)) {
    return NextResponse.json({ error: `Unknown provider "${body.provider}".` }, { status: 400 });
  }

  await addWatchlistEntry({
    provider: body.provider,
    handle: body.handle.trim(),
    label: body.label.trim(),
    domain: body.domain?.trim() || null,
  });

  return NextResponse.json({ watchlist: await listWatchlist() });
}

export async function DELETE(req: Request) {
  const id = Number(new URL(req.url).searchParams.get("id"));
  if (!Number.isInteger(id) || id <= 0) {
    return NextResponse.json({ error: "A numeric ?id is required." }, { status: 400 });
  }
  await removeWatchlistEntry(id);
  return NextResponse.json({ watchlist: await listWatchlist() });
}
