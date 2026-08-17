import Anthropic from "@anthropic-ai/sdk";

export const MODEL = "claude-opus-5";

let client: Anthropic | null = null;

/**
 * Zero-arg construction on purpose: the SDK resolves ANTHROPIC_API_KEY, then
 * ANTHROPIC_AUTH_TOKEN, then an `ant auth login` profile. An unset env var does
 * not mean there are no credentials.
 */
export function anthropic(): Anthropic {
  if (!client) client = new Anthropic();
  return client;
}

export class AiRefusalError extends Error {
  readonly category: string | null;

  constructor(category: string | null) {
    super(
      `Claude declined this request${category ? ` (${category})` : ""}. ` +
        `The signal text may have tripped a safety classifier — skip this lead or edit the evidence.`,
    );
    this.category = category;
  }
}

export class AiTruncatedError extends Error {
  constructor() {
    super("Response hit max_tokens before completing. Raise maxTokens for this stage.");
  }
}

export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

interface JsonCallOptions {
  system: string;
  prompt: string;
  /** JSON Schema. Must set additionalProperties:false and list every key in `required`. */
  schema: Record<string, unknown>;
  effort?: Effort;
  maxTokens?: number;
}

/**
 * One structured-output call. `output_config.format` constrains the response to
 * the schema, so the first text block is always parseable JSON — no regex
 * extraction and no retry-on-parse loop.
 *
 * Opus 5 thinks by default and `max_tokens` caps thinking *plus* output, hence
 * the generous default.
 */
export async function jsonCall<T>({
  system,
  prompt,
  schema,
  effort = "medium",
  maxTokens = 16_000,
}: JsonCallOptions): Promise<T> {
  const params = {
    model: MODEL,
    max_tokens: maxTokens,
    system,
    messages: [{ role: "user" as const, content: prompt }],
    output_config: { effort, format: { type: "json_schema" as const, schema } },
  };

  const response = await createWithFallback(params);

  if (response.stop_reason === "refusal") {
    // `stop_details` is newer than the installed SDK's typings.
    const details = (response as { stop_details?: { category?: string } | null }).stop_details;
    throw new AiRefusalError(details?.category ?? null);
  }
  if (response.stop_reason === "max_tokens") throw new AiTruncatedError();

  const text = response.content.find(
    (b): b is Anthropic.TextBlock => b.type === "text",
  )?.text;
  if (!text) throw new Error("Claude returned no text block.");

  return JSON.parse(text) as T;
}

/**
 * Opus 5's safety classifiers can decline a request outright. Server-side
 * fallbacks re-run the declined request on Anthropic's recommended substitute
 * inside the same call, routed by refusal category, so a false positive on
 * benign sales copy recovers instead of surfacing as an error.
 *
 * The `fallbacks` parameter is newer than the installed SDK's typings, so it is
 * passed through untyped; if the endpoint rejects the beta we retry once on the
 * plain endpoint rather than failing the whole pipeline.
 */
async function createWithFallback(
  params: Record<string, unknown>,
): Promise<Anthropic.Message> {
  const beta = anthropic().beta.messages as unknown as {
    create(p: Record<string, unknown>): Promise<Anthropic.Message>;
  };

  try {
    return await beta.create({
      ...params,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
    });
  } catch (err) {
    if (err instanceof Anthropic.BadRequestError) {
      const plain = anthropic().messages as unknown as {
        create(p: Record<string, unknown>): Promise<Anthropic.Message>;
      };
      return plain.create(params);
    }
    throw err;
  }
}

const NO_CREDENTIALS =
  "No Anthropic credentials found. Put ANTHROPIC_API_KEY in .env (see .env.example), " +
  "or run `ant auth login` — the SDK picks up either automatically. " +
  "Signal ingestion works without it; scoring, ICP inference, and message writing do not.";

/** Turns SDK errors into something an API route can hand to the UI. */
export function describeAiError(err: unknown): { status: number; message: string } {
  // Thrown client-side before any request is made, so it is a plain Error
  // rather than an AuthenticationError — and it is the likeliest first-run
  // failure, so it gets the friendly message too.
  if (err instanceof Error && /could not resolve authentication method/i.test(err.message))
    return { status: 401, message: NO_CREDENTIALS };
  if (err instanceof Anthropic.AuthenticationError)
    return { status: 401, message: NO_CREDENTIALS };
  if (err instanceof Anthropic.RateLimitError)
    return { status: 429, message: "Rate limited by the Anthropic API. Retry shortly." };
  if (err instanceof AiRefusalError) return { status: 422, message: err.message };
  if (err instanceof Anthropic.APIConnectionError)
    return { status: 503, message: "Could not reach the Anthropic API. Check your connection." };
  if (err instanceof Anthropic.APIError)
    return { status: err.status ?? 500, message: err.message };
  return { status: 500, message: err instanceof Error ? err.message : String(err) };
}
