import { tracedFetch } from "./instrumented-fetch";

export const SPECTRUM_CLOUD_URL =
  process.env.SPECTRUM_CLOUD_URL ?? "https://spectrum.photon.codes";

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
  numbers: Record<string, string | null>;
  type: "dedicated";
}

export type TokenData = SharedTokenData | DedicatedTokenData;

export type CloudPlatform = "imessage" | "whatsapp_business" | "slack";

export interface PlatformStatus {
  enabled: boolean;
}

export type PlatformsData = Record<CloudPlatform, PlatformStatus>;

export interface ImessageInfoData {
  type: "shared" | "dedicated";
}

export interface WhatsappBusinessTokenData {
  auth: Record<string, string>;
  expiresIn: number;
  numbers: Record<string, string | null>;
}

export interface SlackTeamMeta {
  appId: string;
  botUserId: string;
  grantedScopes: string[];
  teamName: string;
}

export interface SlackTokenData {
  auth: Record<string, string>;
  expiresIn: number;
  teams: Record<string, SlackTeamMeta>;
}

export interface FusorTokenData {
  expiresIn: number;
  token: string;
}

/**
 * Per-project profile bag — a flexible record of project-level settings
 * defined in Spectrum Cloud. Concrete fields depend on the project; consumers
 * read them as `app.config.profile.<key>`.
 */
export interface ProjectProfile {
  [key: string]: unknown;
}

/**
 * The project record returned by `GET /projects/{projectId}/`. Populated on
 * `app.config` when `Spectrum()` is called with `projectId` + `projectSecret`.
 */
export interface ProjectData {
  id: string;
  name: string;
  profile: ProjectProfile;
  /**
   * URL-safe project identifier (e.g. `what-c62a6`). Used as the subdomain of
   * the Fusor "super webhook" edge a platform registers its provider webhook
   * against — see Telegram's `webhookUrl`.
   */
  slug: string;
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

// Spectrum's calls to its own cloud API, traced as CLIENT spans. The URL
// carries no secret (Basic auth lives in init.headers), so no redaction needed.
const cloudFetch = tracedFetch("spectrum-cloud");

const request = async <T>(path: string, init?: RequestInit): Promise<T> => {
  const response = await cloudFetch(`${SPECTRUM_CLOUD_URL}${path}`, init);

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
  getProject: (
    projectId: string,
    projectSecret: string
  ): Promise<ProjectData> =>
    request(`/projects/${projectId}/`, {
      headers: { Authorization: basicAuth(projectId, projectSecret) },
    }),

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

  issueWhatsappBusinessTokens: (
    projectId: string,
    projectSecret: string
  ): Promise<WhatsappBusinessTokenData> =>
    request(`/projects/${projectId}/whatsapp-business/tokens`, {
      method: "POST",
      headers: { Authorization: basicAuth(projectId, projectSecret) },
    }),

  issueSlackTokens: (
    projectId: string,
    projectSecret: string
  ): Promise<SlackTokenData> =>
    request(`/projects/${projectId}/slack/tokens`, {
      method: "POST",
      headers: { Authorization: basicAuth(projectId, projectSecret) },
    }),

  issueFusorToken: (
    projectId: string,
    projectSecret: string
  ): Promise<FusorTokenData> =>
    request(`/projects/${projectId}/fusor/token`, {
      method: "POST",
      headers: { Authorization: basicAuth(projectId, projectSecret) },
    }),

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
