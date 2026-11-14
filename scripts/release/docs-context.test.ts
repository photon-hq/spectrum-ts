import { execFileSync, spawnSync } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { parse } from "yaml";
import { REPO_ROOT } from "./packages";

it("collects external stable release context from real Git tree fixtures", () => {
  expect(() =>
    execFileSync("python3", ["scripts/release/test_docs_context.py"], {
      cwd: REPO_ROOT,
      env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" },
      stdio: "pipe",
    })
  ).not.toThrow();
});

it("requests every CODEOWNER independently and warns without losing later reviewers", async () => {
  const root = await mkdtemp(join(tmpdir(), "spectrum-docs-reviewers-"));
  try {
    const workflow = parse(
      await readFile(
        join(REPO_ROOT, ".github/workflows/update-docs.yaml"),
        "utf8"
      )
    );
    const step = workflow.jobs["update-docs"].steps.find(
      (entry: { name: string }) => entry.name === "Request source reviewers"
    );
    const gh = join(root, "gh");
    const log = join(root, "requests");
    await writeFile(
      gh,
      `#!/bin/sh
printf '%s\\n' "$5" >> "$REQUEST_LOG"
[ "$5" != former-member ]
`
    );
    await chmod(gh, 0o755);
    const result = spawnSync("bash", ["-euo", "pipefail", "-c", step.run], {
      env: {
        ...process.env,
        PATH: `${root}:${process.env.PATH}`,
        REQUEST_LOG: log,
        PR_URL: "https://github.com/photon-hq/docs/pull/1",
        REVIEWERS: "former-member,photon-hq/sdk-team,current-owner",
      },
      encoding: "utf8",
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(
      "::warning::Could not request review from former-member"
    );
    expect((await readFile(log, "utf8")).trim().split("\n")).toEqual([
      "former-member",
      "photon-hq/sdk-team",
      "current-owner",
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
