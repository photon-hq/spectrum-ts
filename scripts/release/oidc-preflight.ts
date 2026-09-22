#!/usr/bin/env bun
/**
 * Prove npm OIDC trusted publishing is wired up for every publishable package
 * BEFORE the release bumps, tags, or creates a GitHub release.
 *
 * Why: `npm publish` hides every trusted-publishing failure behind a generic
 * `E404 Not Found - PUT …` (the exchange errors are only logged at
 * `--loglevel verbose`), and by the time npm-publish runs, bump-version has
 * already pushed the release commit and github-release has cut the tag. Three
 * versions (12.9.0, 12.9.1, 12.10.0) ended up tagged but never on npm that
 * way. This script does the same two calls npm does, but loudly:
 *
 * 1. Fetch a GitHub Actions ID token with audience `npm:registry.npmjs.org`
 *    (needs `permissions: id-token: write` on the calling job).
 * 2. POST it to npm's token-exchange endpoint once per package. npm only
 *    honours the exchange when the package has a trusted publisher whose
 *    repository / workflow filename / environment match the token's claims.
 *
 * On failure it prints the token's identity claims and the exact values to
 * enter on npmjs.com, then exits 1 so the workflow stops before mutating
 * anything. Packages that don't exist on the registry yet are reported as a
 * warning, not a failure — a trusted publisher can't exist for an unpublished
 * name, so the first publish of a new package has to go through NPM_TOKEN.
 *
 * Usage (inside GitHub Actions only): bun scripts/release/oidc-preflight.ts
 */

import { publishablePackages } from "./packages";

const REGISTRY = "https://registry.npmjs.org";
const AUDIENCE = `npm:${new URL(REGISTRY).hostname}`;
const FETCH_TIMEOUT_MS = 15_000;
const BODY_PREVIEW_CHARS = 300;
const JWT_PARTS = 3;
const JWT_PAYLOAD_INDEX = 1;

// The ID-token claims npm's trusted-publisher matcher looks at. Printed so a
// mismatch against the npmjs.com configuration is obvious from the log.
const IDENTITY_CLAIMS = [
  "repository",
  "repository_owner",
  "workflow_ref",
  "job_workflow_ref",
  "environment",
  "ref",
  "event_name",
  "aud",
] as const;

type Claims = Partial<Record<(typeof IDENTITY_CLAIMS)[number], string>>;

interface ExchangeResult {
  message: string;
  ok: boolean;
  status: number;
}

const requestUrl = process.env.ACTIONS_ID_TOKEN_REQUEST_URL;
const requestToken = process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
if (!(requestUrl && requestToken)) {
  console.error(
    "::error::oidc-preflight: ACTIONS_ID_TOKEN_REQUEST_URL/TOKEN are not set. This script only runs inside GitHub Actions, in a job with `permissions: id-token: write`."
  );
  process.exit(1);
}

const bodyPreview = async (res: Response): Promise<string> => {
  const text = (await res.text()).replace(/\s+/g, " ").trim();
  return text.length > BODY_PREVIEW_CHARS
    ? `${text.slice(0, BODY_PREVIEW_CHARS)}…`
    : text;
};

async function fetchIdToken(): Promise<string> {
  const url = new URL(requestUrl as string);
  url.searchParams.set("audience", AUDIENCE);
  const res = await fetch(url, {
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${requestToken}`,
    },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) {
    throw new Error(
      `GitHub ID-token request failed: HTTP ${res.status} ${await bodyPreview(res)}`
    );
  }
  const json = (await res.json()) as { value?: string };
  if (!json.value) {
    throw new Error("GitHub ID-token response had no `value`");
  }
  return json.value;
}

function decodeClaims(jwt: string): Claims {
  const parts = jwt.split(".");
  if (parts.length !== JWT_PARTS) {
    return {};
  }
  const payload = Buffer.from(parts[JWT_PAYLOAD_INDEX] ?? "", "base64url");
  const all = JSON.parse(payload.toString("utf8")) as Record<string, unknown>;
  const claims: Claims = {};
  for (const key of IDENTITY_CLAIMS) {
    const value = all[key];
    if (typeof value === "string") {
      claims[key] = value;
    }
  }
  return claims;
}

// 200 → the name exists on npm (a trusted publisher can be configured);
// 404 → never published (first publish must go through NPM_TOKEN).
async function existsOnRegistry(name: string): Promise<boolean> {
  const res = await fetch(`${REGISTRY}/${name}`, {
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  return res.status === 200;
}

async function exchange(
  name: string,
  idToken: string
): Promise<ExchangeResult> {
  // Same escaping npm-package-arg applies: only the scope slash is encoded.
  const escapedName = name.replace("/", "%2f");
  const res = await fetch(
    `${REGISTRY}/-/npm/v1/oidc/token/exchange/package/${escapedName}`,
    {
      method: "POST",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${idToken}`,
        "Content-Type": "application/json",
      },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    }
  );
  if (!res.ok) {
    return { ok: false, status: res.status, message: await bodyPreview(res) };
  }
  const json = (await res.json()) as { token?: string };
  if (!json.token) {
    return {
      ok: false,
      status: res.status,
      message: "exchange succeeded but the response carried no `token`",
    };
  }
  return { ok: true, status: res.status, message: "trusted publisher matched" };
}

// What to type into npmjs.com → package → Settings → Trusted Publisher, derived
// from the token so the guide always reflects the workflow that actually ran.
function trustedPublisherGuide(claims: Claims): string {
  const [owner = "<org>", repo = "<repo>"] = (claims.repository ?? "").split(
    "/"
  );
  const workflowFile =
    claims.workflow_ref?.split("/.github/workflows/")[1]?.split("@")[0] ??
    "<workflow>.yaml";
  return [
    "  Publisher:            GitHub Actions",
    `  Organization or user: ${owner}`,
    `  Repository:           ${repo}`,
    `  Workflow filename:    ${workflowFile}`,
    `  Environment name:     ${claims.environment ?? "(leave empty — this job sets none)"}`,
  ].join("\n");
}

const idToken = await fetchIdToken();
const claims = decodeClaims(idToken);

console.log("OIDC identity presented to npm:");
for (const key of IDENTITY_CLAIMS) {
  console.log(`  ${key.padEnd(18)} ${claims[key] ?? "(absent)"}`);
}
console.log();

const pkgs = await publishablePackages();
const failures: string[] = [];
const unpublished: string[] = [];

for (const { json } of pkgs) {
  const { name } = json;
  if (!(await existsOnRegistry(name))) {
    unpublished.push(name);
    console.log(
      `• ${name}: not on the registry yet — first publish must use NPM_TOKEN; configure its trusted publisher afterwards`
    );
    continue;
  }
  const result = await exchange(name, idToken);
  if (result.ok) {
    console.log(`✓ ${name}: ${result.message}`);
  } else {
    failures.push(name);
    console.log(`✗ ${name}: HTTP ${result.status} ${result.message}`);
  }
}

console.log();
if (unpublished.length > 0) {
  console.log(
    `::warning::oidc-preflight: ${unpublished.length} package(s) have never been published and will need the NPM_TOKEN fallback: ${unpublished.join(", ")}`
  );
}
if (failures.length > 0) {
  console.error(
    `::error::oidc-preflight: npm rejected the OIDC token exchange for ${failures.length} package(s): ${failures.join(", ")}`
  );
  console.error(
    "\nEach package above needs a trusted publisher on npmjs.com (package → Settings → Trusted Publisher) matching this workflow exactly:\n"
  );
  console.error(trustedPublisherGuide(claims));
  console.error(
    "\nNothing was bumped, tagged, or published. Re-run the release once the trusted publishers are in place, or dispatch with `skip-oidc-preflight: true` to fall back to NPM_TOKEN knowingly."
  );
  process.exit(1);
}
console.log(
  `✓ oidc-preflight: trusted publishing verified for ${pkgs.length - unpublished.length}/${pkgs.length} packages`
);
