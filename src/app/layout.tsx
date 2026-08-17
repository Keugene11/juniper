import type { Metadata } from "next";
import { DM_Sans } from "next/font/google";
import { Nav } from "@/components/nav";
import "./globals.css";

const dmSans = DM_Sans({
  subsets: ["latin"],
  variable: "--font-dm-sans",
  display: "swap",
});

export const metadata: Metadata = {
  title: "Juniper — signal-based prospecting",
  description:
    "Detect buying signals, score them against your ICP, and write outreach conditioned on the trigger event.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={dmSans.variable}>
      <body className="min-h-dvh pb-24 md:pb-0">
        <Nav />
        <main className="mx-auto w-full max-w-3xl px-4 py-6 md:py-10">{children}</main>
      </body>
    </html>
  );
}
