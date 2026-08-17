import { jsonCall } from "./claude";
import type { Profile } from "./db";
import { SIGNAL_LABEL, type Signal } from "./signals/types";

export interface GeneratedSequence {
  subject: string;
  body: string;
  followUps: { dayOffset: number; body: string }[];
}

/**
 * The point of the whole pipeline: a message conditioned on the specific event,
 * not a mail-merge template. The signal's `evidence` is the one thing that must
 * survive into the copy.
 */
export async function generateSequence(
  profile: Profile,
  signal: Signal,
  channel: "email" | "linkedin",
): Promise<GeneratedSequence> {
  const recipient = signal.personName ?? `the ${profile.icp.buyerTitles[0] ?? "buyer"}`;

  return jsonCall<GeneratedSequence>({
    effort: "medium",
    system:
      "You write cold outreach for a B2B seller. Rules: open by referencing the specific " +
      "trigger event, never with a generic compliment. One clear idea per message. No " +
      "buzzwords, no 'I hope this finds you well', no fake familiarity, no claims about the " +
      "prospect you were not told. Under 120 words for the first message and under 70 for " +
      "each follow-up. End with a low-friction question, not a demo demand.",
    prompt:
      `SELLER: ${profile.companyName}\n` +
      `WHAT THEY SELL: ${profile.valueProp}\n` +
      `BUYER PAIN POINTS: ${profile.icp.painPoints.join("; ")}\n\n` +
      `CHANNEL: ${channel}\n` +
      `RECIPIENT: ${recipient}` +
      (signal.personTitle ? `, ${signal.personTitle}` : "") +
      ` at ${signal.company}\n\n` +
      `TRIGGER EVENT (${SIGNAL_LABEL[signal.kind]})\n` +
      `${signal.headline}\n${signal.evidence}\n\n` +
      `Write the opening message plus two follow-ups (day 3 and day 7). Each follow-up must ` +
      `add a new angle — do not restate the first message. ` +
      (channel === "linkedin"
        ? `LinkedIn: no subject line is used, so return an empty string for subject and keep ` +
          `the first message under 280 characters so it fits a connection note.`
        : `Email: the subject must be under 45 characters and reference the trigger, not the product.`),
    schema: {
      type: "object",
      additionalProperties: false,
      required: ["subject", "body", "followUps"],
      properties: {
        subject: { type: "string" },
        body: { type: "string" },
        followUps: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["dayOffset", "body"],
            properties: {
              dayOffset: { type: "integer" },
              body: { type: "string" },
            },
          },
        },
      },
    },
  });
}

/** Step 0 goes out now; follow-ups are offset in days from the same anchor. */
export function scheduleFor(dayOffset: number, from = new Date()): string {
  return new Date(from.getTime() + dayOffset * 86_400_000).toISOString();
}
