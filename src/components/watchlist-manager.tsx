"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Plus, Trash2, Loader2, Sparkles } from "lucide-react";
import type { WatchlistEntry } from "@/lib/db";

/**
 * The job-board providers are watchlist-driven: you tell Juniper which
 * companies to watch and what their board handle is, because there is no public
 * index of "every company on Greenhouse".
 */
export function WatchlistManager({ initial }: { initial: WatchlistEntry[] }) {
  const router = useRouter();
  const [entries, setEntries] = useState(initial);
  const [provider, setProvider] = useState("greenhouse");
  const [handle, setHandle] = useState("");
  const [label, setLabel] = useState("");
  const [domain, setDomain] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [finding, setFinding] = useState(false);
  const [found, setFound] = useState<string | null>(null);

  /**
   * Derives companies from the saved ICP. `replace: false` here — the button
   * tops the list up, and anything already on it was either discovered before
   * or added by hand, neither of which this should throw away.
   */
  async function discover() {
    setFinding(true);
    setError(null);
    setFound(null);
    try {
      const res = await fetch("/api/watchlist/discover", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ replace: false }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? `Request failed (${res.status})`);
      setEntries(body.watchlist as WatchlistEntry[]);
      setFound(summarise(body.added?.length ?? 0, body.rejected?.length ?? 0));
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setFinding(false);
    }
  }

  async function send(init: RequestInit, url = "/api/watchlist") {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(url, init);
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? `Request failed (${res.status})`);
      setEntries(body.watchlist as WatchlistEntry[]);
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
      body: JSON.stringify({ provider, handle, label, domain }),
    }).then(() => {
      setHandle("");
      setLabel("");
      setDomain("");
    });

  return (
    <section className="card p-4">
      <h2 className="text-sm font-medium">Watchlist</h2>
      <p className="mt-1 text-xs leading-relaxed text-muted">
        Companies to monitor for hiring signals. Rebuilt from your ICP whenever you analyse
        your website, with every handle checked against the live board before it is stored. The
        handle is the slug in their board URL —
        e.g. <code className="rounded bg-wash px-1">stripe</code> for{" "}
        <code className="rounded bg-wash px-1">boards.greenhouse.io/stripe</code>. For Unipile
        the handle is a LinkedIn <em>post id</em> instead: everyone who reacted or commented on
        that post becomes a competitor-engagement signal.
      </p>

      <button
        onClick={discover}
        disabled={busy || finding}
        className="press mt-3 flex w-full items-center justify-center gap-2 btn-primary px-4 py-2.5 text-sm"
      >
        {finding ? <Loader2 size={15} className="spinning" /> : <Sparkles size={15} />}
        {finding ? "Finding companies" : "Find companies from my ICP"}
      </button>
      {found && <p className="mt-2 text-xs leading-relaxed text-muted">{found}</p>}

      <p className="mt-4 text-xs text-muted">Or add one by hand</p>
      <div className="mt-3 grid grid-cols-2 gap-2">
        <select
          value={provider}
          onChange={(e) => setProvider(e.target.value)}
          className="press col-span-2 rounded-full border border-line px-3 py-2 text-sm sm:col-span-1"
        >
          <option value="greenhouse">Greenhouse</option>
          <option value="lever">Lever</option>
          <option value="ashby">Ashby</option>
          <option value="unipile">LinkedIn post (Unipile)</option>
        </select>
        <input
          value={handle}
          onChange={(e) => setHandle(e.target.value)}
          placeholder="board handle"
          className="col-span-2 rounded-full border border-line px-3 py-2 text-sm outline-none focus:border-ink sm:col-span-1"
        />
        <input
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          placeholder="Company name"
          className="rounded-full border border-line px-3 py-2 text-sm outline-none focus:border-ink"
        />
        <input
          value={domain}
          onChange={(e) => setDomain(e.target.value)}
          placeholder="domain.com"
          className="rounded-full border border-line px-3 py-2 text-sm outline-none focus:border-ink"
        />
      </div>

      <button
        onClick={add}
        disabled={busy || !handle.trim() || !label.trim()}
        className="press mt-2 flex w-full items-center justify-center gap-2 rounded-full border border-ink px-4 py-2.5 text-sm font-medium"
      >
        {busy ? <Loader2 size={15} className="spinning" /> : <Plus size={15} />}
        Add to watchlist
      </button>

      {error && <p className="mt-2 text-xs text-muted">{error}</p>}

      {entries.length > 0 && (
        <ul className="mt-4 divide-y divide-line border-t border-line">
          {entries.map((e) => (
            <li key={e.id} className="flex items-center gap-3 py-2.5">
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium">{e.label}</p>
                <p className="truncate text-xs text-muted">
                  {e.provider} / {e.handle}
                  {e.domain ? ` · ${e.domain}` : " · no domain (blocks enrichment)"}
                </p>
              </div>
              <button
                onClick={() => send({ method: "DELETE" }, `/api/watchlist?id=${e.id}`)}
                disabled={busy}
                aria-label={`Remove ${e.label}`}
                className="press rounded-full p-2 text-muted hover:bg-wash"
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

/**
 * Says what happened to the rejects as well as the keeps. A proposed company
 * whose board handle answered nowhere is dropped rather than stored — silently
 * discarding them would leave the count unexplained, and a wrong handle sitting
 * in the watchlist is invisible except as a 404 warning on every future run.
 */
function summarise(added: number, rejected: number): string {
  if (added === 0) {
    return rejected === 0
      ? "No companies came back. Re-analyse your website on this tab if the ICP looks thin."
      : `None of the ${rejected} suggested companies had a job board that answered, so none were added.`;
  }
  const kept = `Added ${added} ${added === 1 ? "company" : "companies"} with a verified job board`;
  return rejected === 0
    ? `${kept}.`
    : `${kept}. Dropped ${rejected} whose board handle answered nowhere.`;
}
