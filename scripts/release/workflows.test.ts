import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { parse } from "yaml";
import { publishablePackages, REPO_ROOT } from "./packages";

const PIN = "cfaaa6a4c8870bc21ced10f732fbbc0f4d23384d";
const TAILSCALE = /^tailscale\/github-action@/;
const STAGING_INPUT = /^\$\{\{ inputs\.staging-version \}\}$/;
const RELEASE_TAG_CONTEXT =
  /^\$\{\{ steps\.context\.outputs\.release-tag \}\}$/;
const DRY_RUN_INPUT =
  /^\$\{\{ github\.event_name == 'workflow_dispatch' && inputs\.dry-run \}\}$/;
const workflow = (name: string) =>
  parse(readFileSync(join(REPO_ROOT, ".github/workflows", name), "utf8"));
const stage = workflow("release.yaml");
const promote = workflow("promote.yaml");
const docs = workflow("update-docs.yaml");

it("stages only main pushes without a label gate and requires real CI and verification", () => {
  expect(stage.on.push).toEqual({ branches: ["main"] });
  expect(Object.keys(stage.on)).toEqual(["push", "workflow_dispatch"]);
  expect(stage.on.workflow_dispatch.inputs["dry-run"]).toMatchObject({
    type: "boolean",
    default: true,
  });
  expect(stage.jobs.stage.if).toBe(
    "github.ref == 'refs/heads/main' || (github.event_name == 'workflow_dispatch' && inputs.dry-run)"
  );
  expect(stage.jobs.stage.with["dry-run"]).toMatch(DRY_RUN_INPUT);
  expect(stage.jobs.stage.uses).toBe(
    `photon-hq/buildspace/.github/workflows/package-stage.yml@${PIN}`
  );
  expect(stage.jobs.stage.with).toMatchObject({
    "ci-workflow": "ci.yaml",
    install: "bun install --frozen-lockfile",
    verify: "bun run check && bun run typecheck && bun run test",
    pack: "bun scripts/release/pack.ts",
    environment: "staging",
    "bun-version": readFileSync(join(REPO_ROOT, ".bun-version"), "utf8").trim(),
    "setup-pnpm": false,
  });
  expect(stage.concurrency["cancel-in-progress"]).toBe(false);
});

it("selects exactly the same twelve identities in both channels with npm OIDC", async () => {
  const packages = await publishablePackages();
  const names = packages.map((pkg) => pkg.json.name).sort();
  expect(names).toHaveLength(12);
  for (const job of [stage.jobs.stage, promote.jobs.promote]) {
    expect(job.with["package-selection"].split(" ").sort()).toEqual(names);
    expect(job.with).toMatchObject({
      package: "spectrum-ts",
      registry: "https://registry.npmjs.org",
      "tag-prefix": "spectrum-ts-staging-",
      "production-tag-prefix": "v",
    });
    expect(job.permissions["id-token"]).toBe("write");
    expect(job.secrets).toBeUndefined();
  }
});

it("promotes only an explicit main dispatch through production approval without a rebuild", () => {
  expect(Object.keys(promote.on)).toEqual(["workflow_dispatch"]);
  expect(promote.on.workflow_dispatch.inputs["staging-version"]).toMatchObject({
    type: "string",
    required: true,
  });
  expect(promote.jobs.promote.if).toBe("github.ref == 'refs/heads/main'");
  expect(promote.jobs.promote.uses).toBe(
    `photon-hq/buildspace/.github/workflows/package-promote.yml@${PIN}`
  );
  expect(promote.jobs.promote.with.environment).toBe("production");
  expect(promote.jobs.promote.with["staging-version"]).toMatch(STAGING_INPUT);
  expect(promote.jobs.promote.with["trusted-actor"]).toBeUndefined();
  expect(promote.jobs.promote.with.pack).toBeUndefined();
  expect(promote.jobs.promote.steps).toBeUndefined();
  expect(promote.concurrency["cancel-in-progress"]).toBe(false);
});

it("runs stable notifications and docs explicitly after a successful promotion, not staging", () => {
  const jobs = promote.jobs;
  expect(jobs["release-info"].needs).toBe("promote");
  expect(jobs["release-info"].if).toBe(
    "needs.promote.outputs.pending == 'true'"
  );
  expect(jobs.notify.needs).toEqual(["promote", "release-info"]);
  expect(jobs.notify.if).toBe(
    'contains(fromJSON(\'["major","minor","patch"]\'), needs.release-info.outputs.release-type)'
  );
  expect(jobs.notify.steps[0].uses).toMatch(TAILSCALE);
  expect(jobs.notify.steps[1].run).toContain(
    "http://email-monkey/campaigns/spectrum-release/trigger"
  );
  expect(jobs["bump-webhook"].needs).toBe("promote");
  expect(jobs["bump-webhook"].if).toBe(
    "needs.promote.outputs.pending == 'true'"
  );
  expect(jobs["bump-webhook"].steps[1].run).toContain(
    "event_type=spectrum-ts-released"
  );
  expect(jobs["update-docs"].needs).toEqual(["promote", "release-info"]);
  expect(jobs["update-docs"].uses).toBe("./.github/workflows/update-docs.yaml");
  expect(Object.keys(docs.on)).toEqual([
    "release",
    "workflow_dispatch",
    "workflow_call",
  ]);
  expect(docs.on.release.types).toEqual(["published"]);
  expect(docs.on.workflow_dispatch.inputs["release-tag"]).toMatchObject({
    type: "string",
    required: true,
  });
  expect(docs.jobs["update-docs"].if).toBe(
    "github.event_name != 'release' || (!github.event.release.prerelease && !github.event.release.draft)"
  );
  const update = docs.jobs["update-docs"].steps.find(
    (step: { id: string }) => step.id === "docs"
  );
  expect(update.uses).toBe(
    `photon-hq/buildspace/.github/blocks/update-docs@${PIN}`
  );
  expect(update.with["docs-path"]).toBe("spectrum-ts");
  expect(update.with["release-tag"]).toMatch(RELEASE_TAG_CONTEXT);
});
