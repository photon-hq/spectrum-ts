import {
  type AdvancedIMessage,
  createHttpClient,
} from "@photon-ai/advanced-imessage/http";
import {
  cloud,
  type ImessageResourceTokenData,
  type SharedTokenData,
} from "@spectrum-ts/core";
import {
  createFusorTokenProvider,
  createTokenRenewal,
  type FusorTokenProvider,
  tracedFetch,
} from "@spectrum-ts/core/authoring";
import z from "zod";
import { type RemoteClient, SHARED_PHONE } from "./types";

const DISCOVERY_TIMEOUT_MS = 10_000;
const E164_PATTERN = /^\+[1-9]\d{6,14}$/;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const gatewayFetch = tracedFetch("fusor-imessage");

const gatewayLinesSchema = z.strictObject({
  lines: z.array(
    z.strictObject({
      lineId: z.string().regex(UUID_PATTERN),
      phoneNumber: z.string().regex(E164_PATTERN),
    })
  ),
});

interface CloudAuth {
  dispose: () => Promise<void>;
}

const cloudAuthState = new WeakMap<RemoteClient[], CloudAuth>();

const sharedAddress = (): string =>
  process.env.SPECTRUM_IMESSAGE_HTTP_ADDRESS ?? "imessage-http.photon.codes";

const gatewayBaseUrl = (): URL => {
  const configured =
    process.env.SPECTRUM_IMESSAGE_GATEWAY_ADDRESS ??
    "fusor-imessage.spectrum.photon.codes";
  const url = new URL(
    configured.includes("://") ? configured : `https://${configured}`
  );
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  ) {
    throw new Error("Invalid dedicated iMessage gateway address");
  }
  return url;
};

const requireSharedToken = (data: SharedTokenData): string => {
  if (!data.token) {
    throw new Error("Shared iMessage token response is missing token");
  }
  return data.token;
};

const requireResourceToken = (data: ImessageResourceTokenData): string => {
  if (!data.token) {
    throw new Error(
      "Dedicated iMessage resource token response is missing token; historical spc-* resources cannot be routed through Spectrum"
    );
  }
  return data.token;
};

const readGatewayLines = async (
  tokenProvider: FusorTokenProvider
): Promise<z.infer<typeof gatewayLinesSchema>["lines"]> => {
  const base = gatewayBaseUrl();
  const endpoint = new URL("/v1/lines", base);
  const request = async (): Promise<Response> =>
    await gatewayFetch(endpoint, {
      headers: {
        authorization: `Bearer ${await tokenProvider.getToken()}`,
      },
      redirect: "error",
      signal: AbortSignal.timeout(DISCOVERY_TIMEOUT_MS),
    });

  let response = await request();
  if (response.status === 401) {
    await response.body?.cancel().catch(() => undefined);
    tokenProvider.invalidate();
    response = await request();
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error(
      `Dedicated iMessage gateway line discovery failed (${response.status})`
    );
  }

  const parsed = gatewayLinesSchema.parse(await response.json());
  const lineIds = new Set<string>();
  const phones = new Set<string>();
  for (const line of parsed.lines) {
    if (lineIds.has(line.lineId)) {
      throw new Error(
        `Dedicated iMessage gateway returned duplicate line ${line.lineId}`
      );
    }
    if (phones.has(line.phoneNumber)) {
      throw new Error(
        `Dedicated iMessage gateway returned duplicate phone ${line.phoneNumber}`
      );
    }
    lineIds.add(line.lineId);
    phones.add(line.phoneNumber);
  }
  return parsed.lines;
};

const createSharedClients = async (
  projectId: string,
  projectSecret: string
): Promise<RemoteClient[]> => {
  const issued = await cloud.issueImessageTokens(projectId, projectSecret);
  if (issued.type !== "shared") {
    throw new Error(
      "iMessage mode discovery returned shared but token issuance returned dedicated"
    );
  }
  let tokenData: SharedTokenData = issued;
  requireSharedToken(tokenData);

  const renewal = createTokenRenewal({
    expiresInSeconds: () => tokenData.expiresIn,
    name: "imessage",
    refresh: async () => {
      const refreshed = await cloud.issueImessageTokens(
        projectId,
        projectSecret
      );
      if (refreshed.type !== "shared") {
        throw new Error(
          "Shared iMessage token refresh returned dedicated credentials"
        );
      }
      requireSharedToken(refreshed);
      tokenData = refreshed;
    },
  });

  try {
    const entries: RemoteClient[] = [
      {
        phone: SHARED_PHONE,
        client: createHttpClient({
          address: sharedAddress(),
          autoIdempotency: true,
          retry: true,
          token: async () => {
            await renewal.refreshIfNeeded();
            return requireSharedToken(tokenData);
          },
        }),
      },
    ];
    cloudAuthState.set(entries, {
      dispose: async () => renewal.dispose(),
    });
    return entries;
  } catch (error) {
    renewal.dispose();
    throw error;
  }
};

const lineAddress = (base: URL, lineId: string): string =>
  new URL(`/lines/${encodeURIComponent(lineId)}`, base).toString();

const createDedicatedClients = async (
  projectId: string,
  projectSecret: string
): Promise<RemoteClient[]> => {
  let tokenProvider: FusorTokenProvider | undefined;
  let resourceRenewal: ReturnType<typeof createTokenRenewal> | undefined;
  const opened: AdvancedIMessage[] = [];
  try {
    tokenProvider = await createFusorTokenProvider(projectId, projectSecret);
    const fusorTokens = tokenProvider;
    const base = gatewayBaseUrl();
    const lines = await readGatewayLines(fusorTokens);
    if (lines.length === 0) {
      throw new Error("Dedicated iMessage gateway returned no ready lines");
    }

    let resourceTokenData = await cloud.issueImessageResourceToken(
      projectId,
      projectSecret
    );
    requireResourceToken(resourceTokenData);
    const renewal = createTokenRenewal({
      expiresInSeconds: () => resourceTokenData.expiresIn,
      name: "imessage-resource",
      refresh: async () => {
        const refreshed = await cloud.issueImessageResourceToken(
          projectId,
          projectSecret
        );
        requireResourceToken(refreshed);
        resourceTokenData = refreshed;
      },
    });
    resourceRenewal = renewal;

    const resourceClient = createHttpClient({
      address: sharedAddress(),
      autoIdempotency: true,
      retry: true,
      token: async () => {
        await renewal.refreshIfNeeded();
        return requireResourceToken(resourceTokenData);
      },
    });
    opened.push(resourceClient);
    const entries = lines.map((line): RemoteClient => {
      const client = createHttpClient({
        address: lineAddress(base, line.lineId),
        autoIdempotency: true,
        retry: true,
        token: async () => await fusorTokens.getToken(),
      });
      opened.push(client);
      return {
        client,
        lineId: line.lineId,
        phone: line.phoneNumber,
        resourceClient,
      };
    });
    cloudAuthState.set(entries, {
      dispose: async () => {
        renewal.dispose();
        await fusorTokens.dispose();
      },
    });
    return entries;
  } catch (error) {
    resourceRenewal?.dispose();
    await tokenProvider?.dispose();
    await Promise.allSettled(opened.map((client) => client.close()));
    throw error;
  }
};

export async function createCloudClients(
  projectId: string,
  projectSecret: string
): Promise<RemoteClient[]> {
  const info = await cloud.getImessageInfo(projectId, projectSecret);
  switch (info.type) {
    case "dedicated":
      return await createDedicatedClients(projectId, projectSecret);
    case "shared":
      return await createSharedClients(projectId, projectSecret);
    default:
      throw new Error("Unsupported iMessage mode returned by Spectrum Cloud");
  }
}

export async function disposeCloudAuth(clients: RemoteClient[]): Promise<void> {
  const auth = cloudAuthState.get(clients);
  if (auth) {
    await auth.dispose();
    cloudAuthState.delete(clients);
  }
}
