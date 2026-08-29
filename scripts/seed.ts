/**
 * Writes a placeholder profile straight to the database so the app is usable
 * before you have an Anthropic key.
 *
 *   pnpm seed            profile only
 *   pnpm seed -- --demo  profile plus four demo job boards
 *
 * Running `Analyse` on the Setup tab replaces the profile with a real one
 * inferred from your own website, and fills the watchlist with real companies
 * discovered from that ICP.
 */
import { addWatchlistEntry, getProfile, listWatchlist, saveProfile } from "../src/lib/db";

await saveProfile({
  website: "https://example-seller.com",
  companyName: "Example Seller",
  valueProp:
    "Revenue-operations tooling that stitches CRM, product usage, and billing into one pipeline view for mid-market B2B sales teams.",
  icp: {
    segments: ["Mid-market B2B SaaS", "Usage-based software"],
    companySizes: ["50-200", "200-1000"],
    industries: ["Software", "Fintech", "Logistics tech"],
    buyerTitles: [
      "VP of Revenue Operations",
      "Head of Growth",
      "Chief Revenue Officer",
      "Director of Demand Generation",
    ],
    painPoints: [
      "pipeline data scattered across tools",
      "manual CRM hygiene",
      "no view of product usage at renewal",
      "forecasting from stale data",
    ],
    disqualifiers: [
      "pure B2C",
      "fewer than 20 employees",
      "no dedicated sales team",
      "agencies and consultancies",
    ],
    watchTerms: [
      "revenue operations tooling",
      "CRM data hygiene",
      "sales forecasting accuracy",
      "product usage data sales",
    ],
  },
});

// Demo boards only, and only when asked for. These used to be seeded
// unconditionally, which meant every install started life watching Ramp,
// GitLab and Figma no matter whose website the profile was inferred from — and
// since Ramp lists well over a hundred roles it tripped the hiring-spike
// threshold on every single run, crowding out everything else. The real
// watchlist now comes from `discovery.ts`, derived from your own ICP; this
// block exists purely for offline demos.
if (process.argv.includes("--demo")) {
  const boards: Parameters<typeof addWatchlistEntry>[0][] = [
    { provider: "greenhouse", handle: "gitlab", label: "GitLab", domain: "gitlab.com" },
    { provider: "greenhouse", handle: "figma", label: "Figma", domain: "figma.com" },
    { provider: "lever", handle: "leverdemo", label: "Lever Demo Co", domain: "lever.co" },
    { provider: "ashby", handle: "ramp", label: "Ramp", domain: "ramp.com" },
  ];
  for (const b of boards) await addWatchlistEntry(b);
}

console.log("Seeded profile:", (await getProfile())?.companyName);
console.log("Watchlist entries:", (await listWatchlist()).length);
