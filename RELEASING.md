# Staging and promoting Spectrum

Every push to `main` stages the public SDK packages after CI passes on that
exact commit. No `release` or `prerelease` PR label is needed. **The first
merge of this migration publishes public staging versions to npm.** Staging
is not private: it publishes all twelve existing package names under the
`staging` dist-tag and creates a GitHub prerelease with both channels' archives.
It does not change `latest` or send production notifications.

Both callers pin Buildspace to
`cfaaa6a4c8870bc21ced10f732fbbc0f4d23384d`. Its version job computes the next
shared version from merged PR titles and descriptions since the highest stable
`vX.Y.Z` tag. Conventional Commits and `Release-As: X.Y.Z` determine the bump;
committed package versions do not authorize or name a release.

## Administrator prerequisites before cutover

Do not merge until package maintainers and repository administrators verify
these separately. This migration does not configure them or establish release
acceptance.

1. On **every package below**, create a staging npm trusted publisher for
   GitHub Actions, owner `photon-hq`, repository `spectrum-ts`, workflow
   **`release.yaml`**, environment **`staging`**. Allow both **npm publish** and
   **npm dist-tag**. The caller filename is preserved, but its new `staging`
   environment needs separate trust from the old environment-free publisher.
2. Configure the GitHub **`staging`** environment to allow only the `main`
   branch, with no tag deployment policy. Verify this branch policy separately
   from the workflow's main guard.
3. Configure the GitHub **`production`** environment to allow only the `main`
   branch, with required reviewers, prevention of self-review, and no
   administrator bypass. Buildspace checks for required reviewers before
   requesting approval; do not replace that check with a trusted actor.
4. Shortly before the first production promotion, configure a **separate** npm
   trusted publisher on every package: owner `photon-hq`, repository
   `spectrum-ts`, workflow **`promote.yaml`**, environment **`production`**,
   with both publish and dist-tag rights. Successful staging does not validate
   this publisher. New publishers expire if no successful publish uses them
   within **two days**; recreate an expired publisher before use.
5. Verify the existing `TS_OAUTH_CLIENT_ID` and `TS_OAUTH_SECRET` for
   Tailscale/email-monkey, and `APP_ID` / `APP_PRIVATE_KEY` for the
   `spectrum-webhook` dispatch and docs PR. The App needs contents write on
   `spectrum-webhook`, and contents plus pull requests write on `photon-hq/docs`.
   Docs also needs `ANTHROPIC_API_KEY`. No npm token is passed to either caller;
   Buildspace uses npm 11.21.1, OIDC, and provenance, without token fallback.

The exact selection is identical in stage and promote. Private test support
and examples are excluded. A new publishable package requires a selection
update in both workflows and its own trusted publishers before staging.

| Package | Publication order |
| --- | --- |
| `@spectrum-ts/core` | First |
| `@spectrum-ts/elysia` | Provider |
| `@spectrum-ts/express` | Provider |
| `@spectrum-ts/fastify` | Provider |
| `@spectrum-ts/hono` | Provider |
| `@spectrum-ts/imessage` | Provider |
| `@spectrum-ts/imessage-local` | Provider |
| `@spectrum-ts/slack` | Provider |
| `@spectrum-ts/telegram` | Provider |
| `@spectrum-ts/terminal` | Provider |
| `@spectrum-ts/whatsapp-business` | Provider |
| `spectrum-ts` | Last |

## Build and inspect a candidate

The read-only build runs lint, typecheck and tests under Node and Bun. The pack
adapter reuses the existing lockstep bump and validation scripts, builds with
`SPECTRUM_PUBLISH=1`, checks cleaned output with publint and attw, and packs
each package with npm. It checks each archive's name, version and dependencies.
Both staging and production packs restore temporary package manifests and the
generated core build environment, including on failure. They do not commit a
version bump or update the lockfile. The production candidate is built during
staging, not during promotion.

Staging peers pin the exact `X.Y.Z-staging.<run>.<attempt>` runtime; production
peers retain the matching `^X.0.0` major range. The metapackage pins its runtime
and provider dependencies to that channel's exact version. Buildspace records
the complete dependency order and archive digests in `release-manifest.json`,
attests the archives, then stores them on the staging GitHub prerelease.

For a local pack rehearsal without registry writes, install the pinned Bun
from `.bun-version` and use Node 24.11.1 or later:

```sh
bun install --frozen-lockfile
RELEASE_VERSION=13.0.0 RELEASE_CHANNEL=staging RELEASE_SUFFIX=-staging.42.1 \
  PACK_DESTINATION="$HOME/spectrum-packs/staging" bun scripts/release/pack.ts
RELEASE_VERSION=13.0.0 RELEASE_CHANNEL=production RELEASE_SUFFIX= \
  PACK_DESTINATION="$HOME/spectrum-packs/production" bun scripts/release/pack.ts
```

Use a new empty destination for each rehearsal. These commands build real
archives but do not attest them or prove npm trust or GitHub approval settings.

The existing caller remains `.github/workflows/release.yaml`, displayed as
**Stage** in Actions. Its **Run workflow** entry also rehearses both channel
packs without publishing when **dry-run** is selected (the default). Rehearsals
can run from another branch. A non-main run cannot publish, even if dry-run is
cleared; actual staging publication runs only on main. CI waiting is skipped
for a build-only rehearsal.

## Promote an existing build

Open **Actions → Promote → Run workflow**, select **main**, and enter the exact
staging version from the Stage summary, such as `13.0.0-staging.42.1`.
The read-only resolver checks the staging run, source commit on main,
attestations, candidate digests, package selection, dependency policy and
production reviewers. Review its summary, then approve the production
environment. There is no trusted-actor bypass and no build/install/pack step
in promotion. Only the stored production archives are published under `latest`
and attached to the stable `vX.Y.Z` release.

After a successful promotion that had work to publish, the consumer explicitly
dispatches `spectrum-ts-released` to `spectrum-webhook`, sends the existing
stable major/minor/patch release payload to email-monkey over Tailscale, and
calls the docs workflow. Docs reads the promoted release's notes and compares
its stable baseline (`bump.from`), not the intervening staging tag. It opens a
PR for human review. Releases created with `GITHUB_TOKEN` do not trigger
downstream release-event workflows, so the docs call must remain explicit.
Staging and already-promoted no-op runs send none of these notifications.
The separate Novu proposal in PR #242 is not part of this migration.

Docs also retains its **release published** entry point for stable releases
created manually or by another publisher. **Actions → Update Docs on Release →
Run workflow** can rerun it for an existing stable `vX.Y.Z` tag without another
promotion. Drafts and prereleases are refused. Without a supplied promotion
baseline, it compares against the nearest lower numeric stable tag, or the
empty tree for the first release; staging tags never become the baseline.
CODEOWNERS comes from the released tag, including teams but excluding paths and
comments. Each reviewer request is independent, so an unavailable owner emits
a warning without suppressing the remaining requests.

## Recovery and rollback

A failed npm job can leave immutable versions and a
`candidate-<run>-<attempt>` parking tag before channel tags move. Check every
package's version, integrity, parking tag and `staging`/`latest` tag against
the stored manifest and attestation. Do not promote to repair staging, delete
and republish a version, or assume a new run produces the same archives or
version. Fix publisher rights before choosing a retry. Promotion accepts an
already-published version only when its contents match the candidate.

An already-completed promotion is a no-op, so rerunning it does not resend
notifications or recreate a failed docs PR. Rerun the docs workflow directly
for a docs-only recovery. Recover other failed post-release jobs from that run
after checking which external side effects already succeeded; email delivery
is not transactional with npm publication.

To stop adoption, disable Stage and Promote while administrators investigate.
A workflow revert does not undo npm versions, tags, releases or notifications.
Do not re-enable the old label publisher alongside this pair. Correct a bad
stable release by staging and approving a new version; any manual dist-tag
rollback remains a separate administrator action.
