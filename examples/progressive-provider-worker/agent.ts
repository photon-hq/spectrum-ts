import { type PlatformProviderConfig, Spectrum, text } from "spectrum-ts";

interface RememberedFact {
  source: string;
  value: string;
}

interface ProgressiveWorkerOptions {
  enabledProviders: string[];
  // Entry files pass Spectrum providers here. To add another platform, add its
  // `.config()` result to the providers array in web-only/web-imessage/etc.
  providers: PlatformProviderConfig[];
  requiresCloudCredentials?: boolean;
}

interface CloudCredentials {
  projectId: string;
  projectSecret: string;
}

const DEFAULT_BRIDGE_PORT = 8791;
const DEFAULT_BRIDGE_ENDPOINT = "/spectrum/web/messages";
const REMEMBER_FACT_PATTERN = /^remember my\s+(.+?)\s+is\s+(.+)$/i;
const NAME_PATTERN = /^my name is\s+(.+)$/i;
const QUESTION_PATTERN = /^what(?:['’]s| is) my\s+(.+?)\??$/i;
const WHO_AM_I_PATTERN = /^who am i\??$/i;

const rememberedByUser = new Map<string, Map<string, RememberedFact>>();

function cloudCredentials(): CloudCredentials | undefined {
  const projectId = process.env.SPECTRUM_PROJECT_ID;
  const projectSecret = process.env.SPECTRUM_PROJECT_SECRET;
  if (!(projectId && projectSecret)) {
    return;
  }
  return { projectId, projectSecret };
}

function requireCloudCredentials(): CloudCredentials {
  const credentials = cloudCredentials();
  if (!credentials) {
    throw new Error(
      "Set SPECTRUM_PROJECT_ID and SPECTRUM_PROJECT_SECRET for iMessage examples."
    );
  }
  return credentials;
}

export function webBridgeServerConfig() {
  return {
    apiKey: process.env.SPECTRUM_WORKER_API_KEY ?? "dev",
    endpoint: process.env.SPECTRUM_WORKER_ENDPOINT ?? DEFAULT_BRIDGE_ENDPOINT,
    port: Number(process.env.SPECTRUM_WORKER_PORT ?? DEFAULT_BRIDGE_PORT),
  };
}

function sourceName(platform: string): string {
  if (platform === "iMessage") {
    return "iMessage";
  }
  if (platform === "terminal") {
    return "terminal";
  }
  if (platform === "web-bridge") {
    return "browser useChat";
  }
  return platform;
}

function normalizeKey(input: string): string {
  return input.trim().toLowerCase().replace(/\s+/g, " ");
}

function displayKey(key: string): string {
  return key.replace(/\s+/g, " ").trim();
}

function memoryUserId(space: { userId?: unknown }): string {
  // This demo intentionally maps all enabled transports to one app-owned user
  // so a fact taught in iMessage can be read from the browser. Production apps
  // should replace this with their auth, CRM, or account-linking identity map.
  return (
    process.env.SPECTRUM_DEMO_USER_ID ?? String(space.userId ?? "demo-user")
  );
}

function memoryForUser(userId: string): Map<string, RememberedFact> {
  let memory = rememberedByUser.get(userId);
  if (!memory) {
    memory = new Map<string, RememberedFact>();
    rememberedByUser.set(userId, memory);
  }
  return memory;
}

function extractRememberedFact(input: string):
  | {
      key: string;
      value: string;
    }
  | undefined {
  const normalizedInput = input.trim();
  const rememberMatch = normalizedInput.match(REMEMBER_FACT_PATTERN);
  if (rememberMatch?.[1] && rememberMatch[2]) {
    return {
      key: normalizeKey(rememberMatch[1]),
      value: rememberMatch[2].trim(),
    };
  }

  const nameMatch = normalizedInput.match(NAME_PATTERN);
  if (nameMatch?.[1]) {
    return {
      key: "name",
      value: nameMatch[1].trim(),
    };
  }
}

function extractQuestionKey(input: string): string | undefined {
  const normalizedInput = input.trim();
  const questionMatch = normalizedInput.match(QUESTION_PATTERN);
  if (questionMatch?.[1]) {
    return normalizeKey(questionMatch[1]);
  }

  if (WHO_AM_I_PATTERN.test(normalizedInput)) {
    return "name";
  }
}

function logStartup(enabledProviders: string[], bridgeUrl: string): void {
  console.log("Progressive provider worker");
  console.log(`enabled providers: ${enabledProviders.join(", ")}`);
  console.log(`webBridge URL: ${bridgeUrl}`);
  console.log("Demo examples:");
  console.log("- remember my favorite color is green");
  console.log("- what is my favorite color?");
}

export async function runProgressiveAgent({
  enabledProviders,
  providers,
  requiresCloudCredentials = false,
}: ProgressiveWorkerOptions): Promise<void> {
  const credentials = requiresCloudCredentials
    ? requireCloudCredentials()
    : cloudCredentials();
  // Spectrum's unified platform starts here. The entry file decides which
  // providers are active, then Spectrum merges them into one app.messages loop.
  const app = await Spectrum(
    credentials
      ? {
          ...credentials,
          providers: [...providers],
        }
      : {
          providers: [...providers],
        }
  );

  const bridge = webBridgeServerConfig();
  logStartup(
    enabledProviders,
    `http://127.0.0.1:${bridge.port}${bridge.endpoint}`
  );

  // This is the unified agent surface. Every registered provider above arrives
  // here with the same shape: browser webBridge, iMessage, and terminal all
  // become [space, message]. App logic can stay platform-neutral and reply
  // through space.send(...), which sends back through the originating provider.
  for await (const [space, message] of app.messages) {
    if (message.content.type !== "text") {
      continue;
    }

    const incomingText = message.content.text;
    const source = sourceName(space.__platform);
    const userId = memoryUserId(space as { userId?: unknown });
    const memory = memoryForUser(userId);
    console.log(`[${source} user=${userId}] ${incomingText}`);

    const rememberedFact = extractRememberedFact(incomingText);
    if (rememberedFact) {
      memory.set(rememberedFact.key, {
        source,
        value: rememberedFact.value,
      });
      await space.send(
        text(
          `I will remember your ${displayKey(rememberedFact.key)} is ${rememberedFact.value} from ${source}.`
        )
      );
      continue;
    }

    const questionKey = extractQuestionKey(incomingText);
    if (questionKey) {
      const fact = memory.get(questionKey);
      if (!fact) {
        await space.send(
          text(
            `I do not know your ${displayKey(questionKey)} yet. Tell me with: remember my ${displayKey(questionKey)} is ...`
          )
        );
        continue;
      }

      await space.send(
        text(
          `Your ${displayKey(questionKey)} is ${fact.value}. I learned that from ${fact.source}.`
        )
      );
      continue;
    }

    await space.send(
      text(
        `I received this from ${source}. Try "remember my favorite color is green", then ask "what is my favorite color?" from another platform.`
      )
    );
  }
}
