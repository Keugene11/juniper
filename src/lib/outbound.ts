import type { Profile } from "./db";
import type { LeadView } from "./pipeline";
import { SIGNAL_LABEL, type SignalKind } from "./signals/types";

/**
 * Pushing a finished lead out to wherever the work actually happens.
 *
 * Shaped like the email waterfall in `enrichment.ts`, with one deliberate
 * difference: the waterfall stops at the first success because it wants *an*
 * address, whereas this fans out to every configured destination — Slack and a
 * CRM are not alternatives to each other. Each target reports its own outcome
 * and one failing never stops the others.
 *
 * This is also the half that makes outcome tracking honest. Juniper drafts but
 * never sends, so a lead pushed into HubSpot is worked there and the reply
 * comes back as an outcome on the Leads tab, which is what the Activity tab's
 * per-trigger reply rates are computed from.
 */

export interface PushOutcome {
  target: string;
  ok: boolean;
  /** Human-readable result, kept whether it succeeded or not. */
  detail: string;
  /** Identifier in the destination system, when it returns one. */
  externalId?: string;
}

export interface OutboundTarget {
  id: string;
  label: string;
  requires: string[];
  push(lead: LeadView, profile: Profile | null): Promise<PushOutcome>;
}

/** True when nothing is configured, so callers can skip the whole stage. */
export function outboundConfigured(): boolean {
  return TARGETS.some((t) => available(t));
}

export const outboundTargetStatus = () =>
  TARGETS.map((t) => ({
    id: t.id,
    label: t.label,
    available: available(t),
    missing: t.requires.filter((k) => !process.env[k]),
  }));

const available = (t: OutboundTarget) => t.requires.every((k) => Boolean(process.env[k]));

/**
 * Fans out to every configured destination. Unconfigured ones are reported as
 * skipped rather than omitted, for the same reason unconfigured signal sources
 * are: silence should never be mistaken for success.
 */
export async function pushLead(
  lead: LeadView,
  profile: Profile | null,
): Promise<PushOutcome[]> {
  const outcomes = await Promise.all(
    TARGETS.map(async (target): Promise<PushOutcome> => {
      if (!available(target)) {
        return {
          target: target.id,
          ok: false,
          detail: `skipped — set ${target.requires.join(", ")}`,
        };
      }
      try {
        return await target.push(lead, profile);
      } catch (err) {
        return {
          target: target.id,
          ok: false,
          detail: err instanceof Error ? err.message : String(err),
        };
      }
    }),
  );
  return outcomes;
}

// ------------------------------------------------------------------- helpers

const triggerLabel = (lead: LeadView) =>
  SIGNAL_LABEL[lead.signal.kind as SignalKind] ?? lead.signal.kind;

const nameParts = (full: string | null) => {
  const parts = (full ?? "").trim().split(/\s+/).filter(Boolean);
  return { first: parts[0] ?? "", last: parts.slice(1).join(" ") };
};

async function expectOk(res: Response, target: string): Promise<void> {
  if (res.ok) return;
  // The body carries the actual reason (bad scope, unknown property, bad
  // token); surfacing the status alone sends people hunting for nothing.
  const body = await res.text().catch(() => "");
  throw new Error(`${target} returned HTTP ${res.status}${body ? `: ${body.slice(0, 200)}` : ""}`);
}

// -------------------------------------------------------------------- Slack

/**
 * The cheapest useful destination: one message per qualified lead, with the
 * trigger quoted and a link to the source, which is how a solo founder
 * actually wants to consume this.
 */
const slack: OutboundTarget = {
  id: "slack",
  label: "Slack",
  requires: ["SLACK_WEBHOOK_URL"],

  async push(lead) {
    const who = lead.personName ?? lead.company;
    const res = await fetch(process.env.SLACK_WEBHOOK_URL!, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        text: `${lead.totalScore} · ${who} — ${triggerLabel(lead)}`,
        blocks: [
          {
            type: "section",
            text: {
              type: "mrkdwn",
              text:
                `*${who}*${lead.personTitle ? ` — ${lead.personTitle}` : ""}\n` +
                `${lead.company}${lead.domain ? ` · ${lead.domain}` : ""}`,
            },
          },
          {
            type: "section",
            text: {
              type: "mrkdwn",
              text:
                `*${triggerLabel(lead)}* · score ${lead.totalScore} ` +
                `(fit ${lead.fitScore} / intent ${lead.intentScore}, ` +
                `${Math.round(lead.signal.freshness * 100)}% fresh)\n` +
                `>${lead.signal.headline}`,
            },
          },
          {
            type: "context",
            elements: [
              {
                type: "mrkdwn",
                text:
                  `${lead.email ? `:email: ${lead.email}` : "_no verified address_"}` +
                  `${lead.signal.url ? ` · <${lead.signal.url}|source>` : ""}`,
              },
            ],
          },
        ],
      }),
      signal: AbortSignal.timeout(10_000),
    });
    await expectOk(res, "Slack");
    return { target: "slack", ok: true, detail: "posted" };
  },
};

// ------------------------------------------------------------------ HubSpot

/**
 * Private-app token, scope `crm.objects.contacts.write`. The three `juniper_*`
 * properties are custom ones you create once in HubSpot; without them the write
 * fails with a clear "property does not exist" that `expectOk` passes through.
 */
const hubspot: OutboundTarget = {
  id: "hubspot",
  label: "HubSpot",
  requires: ["HUBSPOT_ACCESS_TOKEN"],

  async push(lead) {
    if (!lead.email) {
      return { target: "hubspot", ok: false, detail: "skipped — contact needs an email address" };
    }
    const { first, last } = nameParts(lead.personName);
    const res = await fetch("https://api.hubapi.com/crm/v3/objects/contacts", {
      method: "POST",
      headers: {
        authorization: `Bearer ${process.env.HUBSPOT_ACCESS_TOKEN!}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        properties: {
          email: lead.email,
          firstname: first || undefined,
          lastname: last || undefined,
          jobtitle: lead.personTitle ?? undefined,
          company: lead.company,
          website: lead.domain ?? undefined,
          // The trigger travels with the contact — without it the CRM record is
          // just another name and whoever works it has nothing to open with.
          juniper_signal_kind: triggerLabel(lead),
          juniper_signal_evidence: lead.signal.evidence.slice(0, 65_000),
          juniper_total_score: String(lead.totalScore),
        },
      }),
      signal: AbortSignal.timeout(12_000),
    });

    // A contact that already exists is a success for our purposes: the lead is
    // in the CRM, which is all the push was asked to guarantee.
    if (res.status === 409) {
      return { target: "hubspot", ok: true, detail: "contact already exists" };
    }
    await expectOk(res, "HubSpot");
    const body = (await res.json()) as { id?: string };
    return { target: "hubspot", ok: true, detail: "contact created", externalId: body.id };
  },
};

// ---------------------------------------------------------------- Pipedrive

const pipedrive: OutboundTarget = {
  id: "pipedrive",
  label: "Pipedrive",
  requires: ["PIPEDRIVE_API_TOKEN"],

  async push(lead) {
    const token = encodeURIComponent(process.env.PIPEDRIVE_API_TOKEN!);

    const personRes = await fetch(`https://api.pipedrive.com/v1/persons?api_token=${token}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: lead.personName ?? lead.company,
        email: lead.email ? [{ value: lead.email, primary: true }] : undefined,
      }),
      signal: AbortSignal.timeout(12_000),
    });
    await expectOk(personRes, "Pipedrive");
    const person = (await personRes.json()) as { data?: { id?: number } };
    const personId = person.data?.id;
    if (!personId) throw new Error("Pipedrive did not return a person id");

    const leadRes = await fetch(`https://api.pipedrive.com/v1/leads?api_token=${token}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        title: `${lead.company} — ${triggerLabel(lead)}`,
        person_id: personId,
      }),
      signal: AbortSignal.timeout(12_000),
    });
    await expectOk(leadRes, "Pipedrive");

    return {
      target: "pipedrive",
      ok: true,
      detail: "person and lead created",
      externalId: String(personId),
    };
  },
};

// ----------------------------------------------------------- generic webhook

/**
 * Everything we have not thought of: Zapier, n8n, Make, or an internal service.
 * The payload is the `LeadView` as-is plus the trigger label, so the contract is
 * the same shape the Leads tab renders.
 */
const webhook: OutboundTarget = {
  id: "webhook",
  label: "Webhook",
  requires: ["JUNIPER_WEBHOOK_URL"],

  async push(lead, profile) {
    const res = await fetch(process.env.JUNIPER_WEBHOOK_URL!, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        // Optional shared secret so the receiver can reject anything else.
        ...(process.env.JUNIPER_WEBHOOK_SECRET
          ? { authorization: `Bearer ${process.env.JUNIPER_WEBHOOK_SECRET}` }
          : {}),
      },
      body: JSON.stringify({
        seller: profile?.companyName ?? null,
        pushedAt: new Date().toISOString(),
        trigger: triggerLabel(lead),
        lead,
      }),
      signal: AbortSignal.timeout(10_000),
    });
    await expectOk(res, "Webhook");
    return { target: "webhook", ok: true, detail: `delivered (HTTP ${res.status})` };
  },
};

const TARGETS: OutboundTarget[] = [slack, webhook, hubspot, pipedrive];
