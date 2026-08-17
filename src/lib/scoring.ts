import { jsonCall } from "./claude";
import type { Profile } from "./db";
import { SIGNAL_STRENGTH, type Signal } from "./signals/types";

export interface ScoredSignal {
  signal: Signal;
  /** How well the company/person matches the ICP, 0-100. Judged by Claude. */
  fitScore: number;
  /** How strongly the event predicts buying, 0-100. Deterministic per signal kind. */
  intentScore: number;
  totalScore: number;
  disqualified: boolean;
  rationale: string;
}

const FIT_WEIGHT = 0.6;
const INTENT_WEIGHT = 0.4;
const BATCH_SIZE = 25;

/**
 * Filters the signal firehose down to a reviewable set.
 *
 * Intent comes from the signal taxonomy and needs no model call. Fit needs
 * judgement, so it goes to Claude — batched, because scoring 60 signals in one
 * call is far cheaper and more consistent than 60 calls.
 */
export async function scoreSignals(
  profile: Profile,
  signals: Signal[],
): Promise<ScoredSignal[]> {
  if (signals.length === 0) return [];

  const out: ScoredSignal[] = [];

  for (let i = 0; i < signals.length; i += BATCH_SIZE) {
    const batch = signals.slice(i, i + BATCH_SIZE);
    const verdicts = await scoreBatch(profile, batch);

    batch.forEach((signal, idx) => {
      const verdict = verdicts[idx] ?? {
        fitScore: 0,
        disqualified: true,
        rationale: "No verdict returned for this signal.",
      };
      const intentScore = SIGNAL_STRENGTH[signal.kind];
      out.push({
        signal,
        fitScore: clamp(verdict.fitScore),
        intentScore,
        totalScore: Math.round(
          clamp(verdict.fitScore) * FIT_WEIGHT + intentScore * INTENT_WEIGHT,
        ),
        disqualified: verdict.disqualified,
        rationale: verdict.rationale,
      });
    });
  }

  return out.sort((a, b) => b.totalScore - a.totalScore);
}

interface Verdict {
  index: number;
  fitScore: number;
  disqualified: boolean;
  rationale: string;
}

async function scoreBatch(profile: Profile, batch: Signal[]): Promise<Verdict[]> {
  const { verdicts } = await jsonCall<{ verdicts: Verdict[] }>({
    effort: "medium",
    system:
      "You qualify inbound buying signals against a seller's ideal customer profile. " +
      "Score fit strictly: a strong signal from a company outside the ICP is still a bad lead. " +
      "Judge only the company and person, not how exciting the event sounds — event strength is " +
      "scored separately. Return one verdict per input signal, in order, with matching indexes.",
    prompt:
      `SELLER: ${profile.companyName}\n` +
      `WHAT THEY SELL: ${profile.valueProp}\n\n` +
      `ICP\n${JSON.stringify(profile.icp, null, 2)}\n\n` +
      `SIGNALS\n${JSON.stringify(
        batch.map((s, index) => ({
          index,
          company: s.company,
          domain: s.domain,
          person: s.personName,
          title: s.personTitle,
          headline: s.headline,
          evidence: s.evidence,
        })),
        null,
        2,
      )}\n\n` +
      `For each: fitScore 0-100 for ICP match, disqualified=true if it trips a stated ` +
      `disqualifier or is clearly not a business the seller can serve, and a one-sentence ` +
      `rationale naming the specific ICP attribute that drove the score.`,
    schema: {
      type: "object",
      additionalProperties: false,
      required: ["verdicts"],
      properties: {
        verdicts: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["index", "fitScore", "disqualified", "rationale"],
            properties: {
              index: { type: "integer" },
              fitScore: { type: "integer" },
              disqualified: { type: "boolean" },
              rationale: { type: "string" },
            },
          },
        },
      },
    },
  });

  // Re-key by index rather than trusting array order.
  const byIndex: Verdict[] = [];
  for (const v of verdicts) if (v.index >= 0 && v.index < batch.length) byIndex[v.index] = v;
  return byIndex;
}

const clamp = (n: number) => Math.max(0, Math.min(100, Math.round(n)));
