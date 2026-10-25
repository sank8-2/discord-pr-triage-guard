# Publishing the policy pack

Pack source: `policies/discord-pr-triage-policies.mjs`  
Pack id / install target: `sank8-2/discord-pr-triage-guard`  
Effect: `enforce`

## Prerequisites

- Policies committed on a clean git tree
- Public GitHub repo (anonymous release-asset download)
- `failproofai` CLI available (`npx failproofai` or global install)
- Auth via `gh auth token` / `GH_TOKEN` / `GITHUB_TOKEN` as `sank8-2`

## Dry-run (no GitHub write)

```bash
npx failproofai publish policies/discord-pr-triage-policies.mjs \
  --dry-run \
  --id sank8-2/discord-pr-triage-guard \
  --version 0.1.0
```

Inspect `dist-pack/`:

- `failproofai-pack.json`
- `failproofai-pack.mjs`
- `SHA256SUMS`

## Publish

```bash
npx failproofai publish policies/discord-pr-triage-policies.mjs \
  --repo sank8-2/discord-pr-triage-guard \
  --id sank8-2/discord-pr-triage-guard \
  --version 0.1.0 \
  --notes "Policy-guarded Discord PR triage: no award without fresh rules, no duplicate awards, no ping before commit, PR text untrusted."
```

## Verify

```bash
npx failproofai policies show sank8-2/discord-pr-triage-guard
npx failproofai policies show sank8-2/discord-pr-triage-guard --releases

# From a clean machine / directory:
npx failproofai policies add sank8-2/discord-pr-triage-guard --all
npx failproofai policies
```

Do not claim “published” until `policies show` reads the release and an install verifies the digest.
