import type { Metadata } from "next";
import { Inter } from "next/font/google";
import { Nav } from "@/components/nav";
import "./globals.css";

// Inter, as Gojiberry uses. Only 400 and 500 are loaded because those are the
// only two weights that appear anywhere on their site — the airiness comes from
// never reaching for bold, and having 600/700 available invites breaking that.
const inter = Inter({
  subsets: ["latin"],
  weight: ["400", "500"],
  variable: "--font-inter",
  display: "swap",
});

export const metadata: Metadata = {
  title: "Juniper — signal-based prospecting",
  description:
    "Detect buying signals, score them against your ICP, and write outreach conditioned on the trigger event.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={inter.variable}>
      <body className="min-h-dvh pb-24 md:pb-0">
        <Nav />
        <main className="mx-auto w-full max-w-3xl px-4 py-6 md:py-10">{children}</main>
      </body>
    </html>
  );
}
