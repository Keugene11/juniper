/**
 * Contact identity — the thing a sequence is actually addressed to.
 *
 * Juniper dedupes *signals* on `dedupeKey`, which stops the same event being
 * ingested twice. It says nothing about people: one company firing a hiring
 * spike and a funding round in the same run is two distinct signals, two
 * distinct leads, and — until this module existed — two sequences to the same
 * inbox. The category treats that as a first-order defect rather than a rough
 * edge, because it wastes sending capacity, annoys the recipient, and quietly
 * corrupts reply-rate reporting by inflating the denominator.
 *
 * Kept free of database imports so the key logic can be tested on its own and
 * used from anywhere.
 */

export interface ContactIdentity {
  email: string | null;
  domain: string | null;
  personName: string | null;
}

/**
 * One key per contact, chosen by specificity: the most precise identifier
 * available wins, and only one is emitted.
 *
 * The person/company split is deliberate. A signal naming a person is keyed to
 * that person, so two different people at the same company can both be worked —
 * which is what a seller expects, and what the rest of the category does. A
 * signal with no person (a hiring spike, a funding round) is company-level by
 * nature, so the company *is* the contact and two of them collapse.
 *
 * Returns null when nothing identifies the contact at all. Callers must treat
 * that as "cannot dedupe" and let it through rather than dropping it, because
 * an unidentifiable lead is still a real lead.
 */
export function contactKey(c: ContactIdentity): string | null {
  const email = norm(c.email);
  if (email) return `email:${email}`;

  const domain = norm(c.domain)?.replace(/^www\./, "");
  const person = norm(c.personName);

  if (person) return `person:${domain ?? ""}:${person}`;
  if (domain) return `company:${domain}`;
  return null;
}

/**
 * Every key this contact could be known by, strongest first.
 *
 * `contactKey` returns the identity a lead is *stored* under; this returns the
 * set to *search* history for. They differ because enrichment arrives late: a
 * lead stored last week under `person:acme.com:dana whitfield` is the same human
 * as today's `email:dana@acme.com`, and only checking both catches it.
 */
export function contactKeys(c: ContactIdentity): string[] {
  const keys: string[] = [];
  const email = norm(c.email);
  const domain = norm(c.domain)?.replace(/^www\./, "");
  const person = norm(c.personName);

  if (email) keys.push(`email:${email}`);
  if (person) keys.push(`person:${domain ?? ""}:${person}`);
  else if (domain) keys.push(`company:${domain}`);

  return keys;
}

// ------------------------------------------------------------- suppression

export type SuppressionKind = "domain" | "email" | "person";

export interface Suppression {
  id: number;
  kind: SuppressionKind;
  value: string;
  reason: string;
  createdAt: string;
}

export function isSuppressionKind(v: unknown): v is SuppressionKind {
  return v === "domain" || v === "email" || v === "person";
}

/** Stored lowercase and trimmed so matching never depends on how it was typed. */
export function normaliseSuppression(kind: SuppressionKind, value: string): string {
  const v = value.trim().toLowerCase();
  if (kind === "domain") {
    // Accept a pasted URL or an @-prefixed domain and reduce both to the host.
    const bare = v.replace(/^https?:\/\//, "").replace(/^@/, "").split("/")[0];
    return bare.replace(/^www\./, "");
  }
  return v;
}

/**
 * The first suppression this contact trips, or null.
 *
 * Domain matching includes subdomains, so suppressing `acme.com` also covers
 * `eu.acme.com` — a customer you must not prospect is not less of a customer
 * because their careers page lives on a subdomain.
 */
export function matchSuppression(
  c: ContactIdentity,
  list: Suppression[],
): Suppression | null {
  const email = norm(c.email);
  const domain = norm(c.domain)?.replace(/^www\./, "");
  const person = norm(c.personName);
  // A suppressed domain must also block addresses at that domain, which is the
  // common case: you add the domain, and the lead arrives with only an email.
  const emailDomain = email?.split("@")[1];

  for (const s of list) {
    if (s.kind === "email" && email && s.value === email) return s;
    if (s.kind === "person" && person && s.value === person) return s;
    if (s.kind === "domain") {
      for (const d of [domain, emailDomain]) {
        if (d && (d === s.value || d.endsWith(`.${s.value}`))) return s;
      }
    }
  }
  return null;
}

const norm = (v: string | null | undefined): string | null => {
  const t = v?.trim().toLowerCase();
  return t ? t : null;
};
