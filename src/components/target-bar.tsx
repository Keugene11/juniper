"use client";

import { useState } from "react";
import { Pencil, X } from "lucide-react";
import { ProfileForm } from "@/components/profile-form";
import type { Profile } from "@/lib/db";

/**
 * Which company Juniper is finding leads for, on the page you actually open.
 *
 * This used to appear only when no profile existed, which meant that the moment
 * you set one, the single most fundamental question the tool answers — *for
 * whom?* — disappeared to the fourth tab. Anyone wanting to point it at a
 * different company had nowhere obvious to go.
 */
export function TargetBar({ profile }: { profile: Profile }) {
  const [editing, setEditing] = useState(false);

  if (editing) {
    return (
      <div className="mb-5">
        <div className="mb-2 flex items-center justify-between">
          <p className="text-xs uppercase tracking-wide text-muted">Change target</p>
          <button
            onClick={() => setEditing(false)}
            className="press inline-flex items-center gap-1 text-xs text-muted underline"
          >
            <X size={11} /> Cancel
          </button>
        </div>
        <ProfileForm initial={profile} />
        <p className="mt-2 text-xs leading-relaxed text-muted">
          Analysing a new site replaces the ICP everything is scored against, and rebuilds the
          watchlist with companies that match it. Leads already collected stay in the database
          but leave this board — they belong to the target they were found for.
        </p>
      </div>
    );
  }

  return (
    <div className="card mb-5 flex flex-wrap items-center gap-x-3 gap-y-1 p-3">
      <span className="text-xs uppercase tracking-wide text-muted">Finding leads for</span>
      <span className="text-sm font-medium">{profile.companyName}</span>
      <span className="text-xs text-muted">{hostOf(profile.website)}</span>
      <button
        onClick={() => setEditing(true)}
        className="press ml-auto inline-flex items-center gap-1.5 rounded-full border border-line px-2.5 py-1.5 text-xs font-medium"
      >
        <Pencil size={12} />
        Change
      </button>
    </div>
  );
}

/** The bar is about identity, not a link — the scheme is noise here. */
function hostOf(website: string): string {
  try {
    return new URL(website).host.replace(/^www\./, "");
  } catch {
    return website;
  }
}
