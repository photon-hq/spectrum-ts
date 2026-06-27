# docs-site

Public Mintlify documentation for `spectrum-ts`, authored here next to the code
and rendered by the [photon-hq/docs](https://github.com/photon-hq/docs)
aggregator. The docs repo pulls this directory at the git tag matching the
published package version, runs [vellum](https://github.com/photon-hq/vellum) to
render `.mdx.vel` → `.mdx`, and merges `nav.json` into the site navigation.

- **Edit pages here** (`*.mdx.vel`). Type signatures are pulled from the package
  source by vellum (`symbol("ts:spectrum-ts#…")`, `<TypeTooltip>`), so prose stays
  in sync with the types as long as docs land in the same release as the code.
- **`nav.json`** is this SDK's slice of the site navigation (the groups the docs
  repo merges into the "Spectrum" tab).
- These templates are built **centrally** in the docs repo; standalone preview
  from this repo is a planned follow-up.
- Not to be confused with [`../docs/`](../docs), which holds internal dev notes.
