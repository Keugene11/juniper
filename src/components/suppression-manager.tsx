"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2, Plus, ShieldOff, Trash2 } from "lucide-react";
import type { Suppression, SuppressionKind } from "@/lib/contacts";

/**
 * The never-contact list: existing customers, competitors, partners, anyone who
 * asked to be left alone.
 *
 * Every serious tool in this category either has one or has it on the roadmap,
 * because the cost of getting it wrong is asymmetric — a missed lead is a missed
 * lead, but mailing a current customer a cold pitch is a conversation with your
 * account manager.
 */
export function SuppressionManager({ initial }: { initial: Suppression[] }) {
  const router = useRouter();
  const [entries, setEntries] = useState(initial);
  const [kind, setKind] = useState<SuppressionKind>("domain");
  const [value, setValue] = useState("");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function send(init: RequestInit, url = "/api/suppressions") {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(url, init);
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? `Request failed (${res.status})`);
      setEntries(body.suppressions as Suppression[]);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  const add = () =>
    send({
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ kind, value, reason }),
    }).then(() => {
      setValue("");
      setReason("");
    });

  return (
    <section className="card p-4">
      <h2 className="flex items-center gap-2 text-sm font-semibold">
        <ShieldOff size={14} />
        Never contact
      </h2>
      <p className="mt-1 text-xs leading-relaxed text-muted">
        Checked before any sequence is written. A suppressed domain also covers its
        subdomains and any address at it, so <code className="rounded bg-wash px-1">acme.com</code>{" "}
        blocks <code className="rounded bg-wash px-1">eu.acme.com</code> and{" "}
        <code className="rounded bg-wash px-1">dana@acme.com</code> too.
      </p>

      <div className="mt-3 grid grid-cols-2 gap-2">
        <select
          value={kind}
          onChange={(e) => setKind(e.target.value as SuppressionKind)}
          className="press col-span-2 rounded-xl border border-line px-3 py-2 text-sm sm:col-span-1"
        >
          <option value="domain">Domain</option>
          <option value="email">Email</option>
          <option value="person">Person</option>
        </select>
        <input
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder={kind === "domain" ? "acme.com" : kind === "email" ? "dana@acme.com" : "Dana Whitfield"}
          className="col-span-2 rounded-xl border border-line px-3 py-2 text-sm outline-none focus:border-ink sm:col-span-1"
        />
        <input
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="Why (optional) — e.g. existing customer"
          className="col-span-2 rounded-xl border border-line px-3 py-2 text-sm outline-none focus:border-ink"
        />
      </div>

      <button
        onClick={add}
        disabled={busy || !value.trim()}
        className="press mt-2 flex w-full items-center justify-center gap-2 rounded-lg border border-ink px-4 py-2.5 text-sm font-medium"
      >
        {busy ? <Loader2 size={15} className="spinning" /> : <Plus size={15} />}
        Add to never-contact
      </button>

      {error && <p className="mt-2 text-xs text-muted">{error}</p>}

      {entries.length > 0 && (
        <ul className="mt-4 divide-y divide-line border-t border-line">
          {entries.map((e) => (
            <li key={e.id} className="flex items-center gap-3 py-2.5">
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium">{e.value}</p>
                <p className="truncate text-xs text-muted">
                  {e.kind}
                  {e.reason ? ` · ${e.reason}` : ""}
                </p>
              </div>
              <button
                onClick={() => send({ method: "DELETE" }, `/api/suppressions?id=${e.id}`)}
                disabled={busy}
                aria-label={`Remove ${e.value}`}
                className="press rounded-lg p-2 text-muted hover:bg-wash"
              >
                <Trash2 size={15} />
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
