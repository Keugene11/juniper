import { NextResponse } from "next/server";
import { isSuppressionKind } from "@/lib/contacts";
import { addSuppression, listSuppressions, removeSuppression } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json({ suppressions: await listSuppressions() });
}

export async function POST(req: Request) {
  const body = (await req.json().catch(() => null)) as {
    kind?: unknown;
    value?: string;
    reason?: string;
  } | null;

  if (!isSuppressionKind(body?.kind)) {
    return NextResponse.json(
      { error: "kind must be one of: domain, email, person." },
      { status: 400 },
    );
  }
  if (!body?.value?.trim()) {
    return NextResponse.json({ error: "A value is required." }, { status: 400 });
  }

  await addSuppression(body.kind, body.value, body.reason?.trim() ?? "");
  return NextResponse.json({ suppressions: await listSuppressions() });
}

export async function DELETE(req: Request) {
  const id = Number(new URL(req.url).searchParams.get("id"));
  if (!Number.isInteger(id) || id <= 0) {
    return NextResponse.json({ error: "A numeric ?id is required." }, { status: 400 });
  }
  await removeSuppression(id);
  return NextResponse.json({ suppressions: await listSuppressions() });
}
