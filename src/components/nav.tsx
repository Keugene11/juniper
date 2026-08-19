"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { BarChart3, Radio, Send, SlidersHorizontal } from "lucide-react";

// Leads first: it is the output, and the reason anyone opens this. Signals is
// where you go to ask why something did or did not become one.
const TABS = [
  { href: "/", label: "Leads", Icon: Send },
  { href: "/signals", label: "Signals", Icon: Radio },
  { href: "/activity", label: "Activity", Icon: BarChart3 },
  { href: "/setup", label: "Setup", Icon: SlidersHorizontal },
];

export function Nav() {
  const pathname = usePathname();

  return (
    <>
      {/* Mobile: fixed bottom bar. Desktop: inline header. */}
      <header className="hidden border-b border-line bg-paper md:block">
        <div className="mx-auto flex w-full max-w-3xl items-center gap-1 px-4 py-3">
          <span className="mr-4 text-sm font-semibold tracking-tight">Juniper</span>
          {TABS.map(({ href, label, Icon }) => {
            const active = pathname === href;
            return (
              <Link
                key={href}
                href={href}
                className={`press flex items-center gap-2 rounded-lg px-3 py-1.5 text-sm ${
                  active ? "bg-ink text-paper" : "text-muted hover:bg-sunken hover:text-ink"
                }`}
              >
                <Icon size={15} strokeWidth={2} />
                {label}
              </Link>
            );
          })}
        </div>
      </header>

      <nav className="fixed inset-x-0 bottom-0 z-20 border-t border-line bg-paper/95 backdrop-blur md:hidden">
        <div className="mx-auto flex max-w-3xl">
          {TABS.map(({ href, label, Icon }) => {
            const active = pathname === href;
            return (
              <Link
                key={href}
                href={href}
                className={`press flex flex-1 flex-col items-center gap-1 py-3 text-xs ${
                  active ? "text-accent-deep" : "text-muted"
                }`}
              >
                <Icon size={19} strokeWidth={active ? 2.4 : 1.8} />
                {label}
              </Link>
            );
          })}
        </div>
      </nav>
    </>
  );
}
