import { NextResponse } from "next/server";
import { describeAiError } from "@/lib/claude";
import { getProfile, saveProfile, type Icp } from "@/lib/db";
import { inferProfileFromWebsite, normaliseUrl } from "@/lib/icp";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json({ profile: await getProfile() });
}

/**
 * Two modes: infer the whole profile from a URL (the onboarding path), or save
 * an edited profile verbatim.
 */
export async function POST(req: Request) {
  let body: { website?: string; companyName?: string; valueProp?: string; icp?: Icp };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Expected a JSON body." }, { status: 400 });
  }

  if (!body.website?.trim()) {
    return NextResponse.json({ error: "A website URL is required." }, { status: 400 });
  }

  let website: string;
  try {
    website = normaliseUrl(body.website);
  } catch {
    return NextResponse.json({ error: `"${body.website}" is not a valid URL.` }, { status: 400 });
  }

  // Manual save — everything supplied, no crawl needed.
  if (body.companyName && body.valueProp && body.icp) {
    return NextResponse.json({
      profile: await saveProfile({
        website,
        companyName: body.companyName,
        valueProp: body.valueProp,
        icp: body.icp,
      }),
    });
  }

  try {
    const inferred = await inferProfileFromWebsite(website);
    return NextResponse.json({ profile: await saveProfile({ website, ...inferred }) });
  } catch (err) {
    const { status, message } = describeAiError(err);
    return NextResponse.json({ error: message }, { status });
  }
}
