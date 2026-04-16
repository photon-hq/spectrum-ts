export const SPECTRUM_CLOUD_URL = `https://${process.env.SPECTRUM_CLOUD_URL ?? "spectrum.photon.codes"}`;

// ---------------------------------------------------------------------------
// API response types (aligned with OpenAPI spec)
// ---------------------------------------------------------------------------

export type SubscriptionStatus = "active" | "canceled" | "past_due";

export interface SubscriptionData {
  status: SubscriptionStatus | null;
  tier: string;
}

export interface SharedTokenData {
  expiresIn: number;
  token: string;
  type: "shared";
}

export interface DedicatedTokenData {
  auth: Record<string, string>;
  expiresIn: number;
  type: "dedicated";
}

export type TokenData = SharedTokenData | DedicatedTokenData;

export type CloudPlatform = "imessage" | "whatsapp_business";

export interface PlatformStatus {
  enabled: boolean;
}

export type PlatformsData = Record<CloudPlatform, PlatformStatus>;

export interface ImessageInfoData {
  type: "shared" | "dedicated";
}

// ---------------------------------------------------------------------------
// Error
// ---------------------------------------------------------------------------

export class SpectrumCloudError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "SpectrumCloudError";
    this.status = status;
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

interface SuccessResponse<T> {
  data: T;
  succeed: true;
}

interface ErrorBody {
  code: string;
  message: string;
  succeed: false;
}

const request = async <T>(path: string, init?: RequestInit): Promise<T> => {
  const response = await fetch(`${SPECTRUM_CLOUD_URL}${path}`, init);

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    try {
      const parsed = JSON.parse(body) as ErrorBody;
      throw new SpectrumCloudError(
        response.status,
        parsed.code,
        parsed.message
      );
    } catch (error) {
      if (error instanceof SpectrumCloudError) {
        throw error;
      }
      throw new SpectrumCloudError(
        response.status,
        "UNKNOWN",
        body || response.statusText
      );
    }
  }

  const json = (await response.json()) as SuccessResponse<T>;
  if (!json.succeed) {
    throw new SpectrumCloudError(
      response.status,
      "UNKNOWN",
      "Server returned succeed=false"
    );
  }

  return json.data;
};

const basicAuth = (projectId: string, projectSecret: string): string =>
  `Basic ${btoa(`${projectId}:${projectSecret}`)}`;

// ---------------------------------------------------------------------------
// Cloud API client
// ---------------------------------------------------------------------------

export const cloud = {
  getSubscription: (projectId: string): Promise<SubscriptionData> =>
    request(`/projects/${projectId}/billing/subscription`),

  issueImessageTokens: (
    projectId: string,
    projectSecret: string
  ): Promise<TokenData> =>
    request(`/projects/${projectId}/imessage/tokens`, {
      method: "POST",
      headers: { Authorization: basicAuth(projectId, projectSecret) },
    }),

  getImessageInfo: (projectId: string): Promise<ImessageInfoData> =>
    request(`/projects/${projectId}/imessage/`),

  getPlatforms: (projectId: string): Promise<PlatformsData> =>
    request(`/projects/${projectId}/platforms/`),

  togglePlatform: (
    projectId: string,
    projectSecret: string,
    platform: CloudPlatform,
    enabled: boolean
  ): Promise<PlatformsData> =>
    request(`/projects/${projectId}/platforms/`, {
      method: "PATCH",
      headers: {
        Authorization: basicAuth(projectId, projectSecret),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ platform, enabled }),
    }),
};
