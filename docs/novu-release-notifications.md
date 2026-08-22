# Novu release notifications

Spectrum release emails are triggered directly from GitHub Actions after the
GitHub release and npm publishing jobs succeed:

```text
release.yaml -> scripts/release/notify-novu.sh -> Novu -> spectrum-updates topic
```

This path does not use Tailscale, email-monkey, or an email-provider SDK. Novu
owns the topic audience, workflow template, retries, preferences, and delivery.

## Required setup

Create these GitHub repository secrets in `photon-hq/spectrum-ts`:

- `NOVU_SECRET_KEY`: the Novu Production environment secret key used by the
  real release workflow.
- `NOVU_DEVELOPMENT_SECRET_KEY`: the Novu Development environment secret key
  used only by the manual smoke workflow.

Set them as GitHub Actions **repository secrets**. Paste each raw Novu secret
key; do not include the `ApiKey` prefix because the script adds it:

```bash
gh auth status
gh secret set NOVU_SECRET_KEY --repo photon-hq/spectrum-ts
gh secret set NOVU_DEVELOPMENT_SECRET_KEY --repo photon-hq/spectrum-ts
gh secret list --repo photon-hq/spectrum-ts
```

The Production key is required for releases. The Development key is required
only for smoke tests run on GitHub; local `act` tests can receive it through the
interactive `-s NOVU_DEVELOPMENT_SECRET_KEY` option.

Never put either key in the repository, workflow inputs, or an `act` event JSON
file. The Novu environment is selected by the secret key, so the Development
environment's `spectrum-updates` topic should contain only controlled test
subscribers.

The Novu configuration must contain:

- Workflow ID: `breaking-change-email`
- Topic key: `spectrum-updates`
- Photon logo environment variable:
  `PHOTON_LOGO_URL=https://raw.githubusercontent.com/photon-hq/email-monkey-assets/main/PhotonDark.png`
- Spectrum hero environment variable:
  `SPECTRUM_HERO_URL=https://raw.githubusercontent.com/photon-hq/email-monkey-assets/main/spectrum-hero.png`

Those two are Novu template environment variables, not GitHub Actions secrets.

Before merging, confirm the Novu **Production** environment—not only
Development—has the active `breaking-change-email` workflow, the configured and
verified email integration, both template environment variables, and the final
subscriber membership for the `spectrum-updates` topic.

The workflow payload schema should accept this shape:

```json
{
  "repo": "photon-hq/spectrum-ts",
  "version": "5.1.0",
  "releaseTag": "v5.1.0",
  "releaseType": "minor",
  "serviceName": "spectrum-ts",
  "releaseDate": "August 22, 2026",
  "releaseYear": "2026",
  "releaseNotesHtml": "<h2>Highlights</h2><ul><li>Example change</li></ul>",
  "releaseUrl": "https://github.com/photon-hq/spectrum-ts/releases/tag/v5.1.0"
}
```

`releaseNotesHtml` is rendered from the generated GitHub-flavored Markdown by
GitHub's Markdown API before Novu is triggered. The script sends the same stable
transaction ID in the Novu body and `Idempotency-Key` header so ordinary retries
do not duplicate a release notification.

## Test locally with OrbStack and act

OrbStack provides the Docker-compatible engine that `act` needs. There is no
reason to open Docker Desktop.

Start OrbStack if it is not already running and confirm the active context:

```bash
orb start
docker context use orbstack
docker info
```

Run the smoke job in its safe default mode. This calls GitHub's Markdown API and
prints the exact Novu JSON, but does not call Novu:

```bash
act workflow_dispatch \
  -W .github/workflows/novu-smoke.yaml \
  -j smoke \
  --input dry_run=true \
  -s GITHUB_TOKEN="$(gh auth token)"
```

To send a real notification through the Novu Development environment, first
confirm its topic contains only test subscribers, then run:

```bash
act workflow_dispatch \
  -W .github/workflows/novu-smoke.yaml \
  -j smoke \
  --input dry_run=false \
  -s GITHUB_TOKEN="$(gh auth token)" \
  -s NOVU_DEVELOPMENT_SECRET_KEY
```

Passing `-s NOVU_DEVELOPMENT_SECRET_KEY` without a value makes `act` prompt for
the key instead of saving it to shell history.

`act` commonly reports the same local run ID on repeated executions. To send a
second deliberate test instead of replaying the idempotent transaction, provide
a new semantic prerelease version, for example `--input version=0.0.0-smoke.2`.

## Test from GitHub

Open **Actions -> Novu Release Notification Smoke Test -> Run workflow**. Leave
`dry_run` enabled for request rendering. Disable it only for a controlled send
through the Development Novu environment.

The production release workflow is unchanged up to the notification boundary:
it still sends only when the GitHub release and npm publish both succeed, skips
dry runs, and only accepts `major`, `minor`, or `patch` release types.

## Ship the change

Push the branch and open a pull request:

```bash
git push -u origin andy/novu-release-notification
gh pr create \
  --repo photon-hq/spectrum-ts \
  --base main \
  --head andy/novu-release-notification \
  --fill
```

After the pull request is merged, the next qualifying real release calls Novu
automatically. Remove the old `TS_OAUTH_CLIENT_ID` and `TS_OAUTH_SECRET`
repository secrets only after the first production notification is confirmed;
this workflow no longer reads them.
