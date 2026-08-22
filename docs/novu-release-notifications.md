# Novu release notifications

Spectrum release emails are triggered directly from GitHub Actions after the
GitHub release and npm publishing jobs succeed:

```text
release.yaml -> scripts/release/notify-novu.sh -> Novu -> spectrum-updates topic
```

This path does not use Tailscale, email-monkey, or an email-provider SDK. Novu
owns the topic audience, workflow template, retries, preferences, and delivery.

## Required setup

Create this GitHub repository secret in `photon-hq/spectrum-ts`:

- `NOVU_SECRET_KEY`: the Novu Production environment secret key used by the
  real release workflow.

Set it as a GitHub Actions **repository secret**. Paste the raw Novu Production
secret key; do not include the `ApiKey` prefix because the script adds it:

```bash
gh auth status
gh secret set NOVU_SECRET_KEY --repo photon-hq/spectrum-ts
gh secret list --repo photon-hq/spectrum-ts
```

Never put the key in the repository or a workflow input. The Novu environment
is selected by the secret key, so this must be the Production key.

The Novu configuration must contain:

- Workflow ID: `breaking-change-email`
- Topic key: `spectrum-updates`
- Photon logo environment variable:
  `PHOTON_LOGO_URL=https://raw.githubusercontent.com/photon-hq/email-monkey-assets/main/PhotonDark.png`
- Spectrum hero environment variable:
  `SPECTRUM_HERO_URL=https://raw.githubusercontent.com/photon-hq/email-monkey-assets/main/spectrum-hero.png`

Those two are Novu template environment variables, not GitHub Actions secrets.

Before merging, confirm the Novu **Production** environment has the active
`breaking-change-email` workflow, the configured and verified email integration,
both template environment variables, and the final subscriber membership for
the `spectrum-updates` topic.

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

## Production behavior

The release workflow sends only when the GitHub release and npm publish both
succeed, skips dry runs, and accepts only `major`, `minor`, or `patch` release
types. Remove the old `TS_OAUTH_CLIENT_ID` and `TS_OAUTH_SECRET` repository
secrets only after the first production notification is confirmed; this workflow
no longer reads them.
