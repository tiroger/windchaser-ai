import "server-only";

import type Anthropic from "@anthropic-ai/sdk";

import { readEnv } from "@/lib/server/env";

import type { AskProvider, AskRequest, Effort } from "./loop";

/**
 * Where Ask's model calls go, mirroring lib/server/briefing.ts: Claude on
 * Amazon Bedrock first (the web compute role has bedrock-mantle access), the
 * Anthropic API as the fallback when a key is configured. LIVE_AI_ENABLED is
 * the shared kill switch and is checked by the route.
 *
 * TRAINING_ASK_MODEL picks the model by its first-party id; the Bedrock
 * client gets the same id with Bedrock's "anthropic." prefix.
 */

const DEFAULT_MODEL = "claude-opus-5-5";
const EFFORTS: Effort[] = ["low", "medium", "high", "xhigh", "max"];

export function askModel(): string {
  return (readEnv("TRAINING_ASK_MODEL") ?? DEFAULT_MODEL).replace(/^anthropic\./, "");
}

export function askEffort(): Effort {
  const value = readEnv("TRAINING_ASK_EFFORT") as Effort | undefined;
  return value && EFFORTS.includes(value) ? value : "medium";
}

/** Both clients expose the same Messages resource. */
type StreamingClient = Pick<Anthropic, "messages">;

function streamingProvider(
  name: string,
  model: string,
  client: () => Promise<StreamingClient>,
): AskProvider {
  return {
    name,
    model,
    async stream(request: AskRequest, onText, signal) {
      const stream = (await client()).messages.stream({ ...request, model }, { signal });
      stream.on("text", (delta) => onText(delta));
      return stream.finalMessage();
    },
  };
}

let bedrockClient: Promise<StreamingClient> | null = null;
let anthropicClient: Promise<StreamingClient> | null = null;

export function askProviders(): AskProvider[] {
  const model = askModel();
  const haveAws = Boolean(
    readEnv("AWS_ACCESS_KEY_ID") ||
      readEnv("AWS_PROFILE") ||
      readEnv("AWS_CONTAINER_CREDENTIALS_RELATIVE_URI") ||
      readEnv("AWS_WEB_IDENTITY_TOKEN_FILE"),
  );
  const haveAnthropic = Boolean(readEnv("ANTHROPIC_API_KEY"));
  const providers: AskProvider[] = [];
  if (haveAws) {
    providers.push(
      streamingProvider("bedrock", `anthropic.${model}`, () =>
        (bedrockClient ??= import("@anthropic-ai/bedrock-sdk").then(
          ({ AnthropicBedrockMantle }) =>
            new AnthropicBedrockMantle({
              awsRegion: readEnv("AWS_REGION") ?? "us-east-1",
              // One retry: the loop has its own wall-clock budget.
              maxRetries: 1,
            }),
        )),
      ),
    );
  }
  if (haveAnthropic) {
    providers.push(
      streamingProvider("anthropic", model, () =>
        (anthropicClient ??= import("@anthropic-ai/sdk").then(
          ({ default: Anthropic }) =>
            new Anthropic({ apiKey: readEnv("ANTHROPIC_API_KEY"), maxRetries: 1 }),
        )),
      ),
    );
  }
  return providers;
}
