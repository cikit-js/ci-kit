# ci-kit

Reusable building blocks for CI pipelines: AI calls, GitLab releases and packages,
changelog generation, release tagging and a small fetch wrapper.

Use the meta package, or install only the part you need.

```bash
npx @imba97/ci-kit changelog --from v1.0.4 --to v1.0.5 --out notes.md
npx @imba97/ci-kit-ai text --prompt-file prompts/review.md --out review.txt
npx @imba97/ci-kit-ai image --prompt "flat illustration, no text" --size 1280x720 --out image.png
npx @imba97/ci-kit-changelog --from v1.0.4 --out notes.md
```

## Packages

| Package | What it does |
| --- | --- |
| `@imba97/ci-kit` | Meta package, re-exports everything and ships the `ci-kit` CLI |
| `@imba97/ci-kit-ai` | Text and image generation, multi-provider presets, `ci-kit-ai` CLI |
| `@imba97/ci-kit-changelog` | Git history to grouped release notes, `ci-kit-changelog` CLI |
| `@imba97/ci-kit-gitlab` | Releases, generic packages, pipeline schedules, pagination |
| `@imba97/ci-kit-env` | Read `.env`, export without breaking JSON values, redact |
| `@imba97/ci-kit-release` | Semver bump, beta/production tag naming, build numbers |
| `@imba97/ci-kit-http` | fetch with timeout, retry and typed errors |

## Design rules

- Modules do not depend on each other except through `@imba97/ci-kit-http`.
- Secrets come from the environment only, never from CLI flags.
- Every network call has a timeout; only 408, 429, 5xx and network errors are retried.
- Prompts are business assets: they live in each project, not in this package.

## Development

```bash
pnpm install
pnpm stub        # link packages for local development
pnpm typecheck
pnpm test
pnpm lint
pnpm build
pnpm release     # bumpp -r
```
## Release

Publishing runs on GitHub Actions with npm trusted publishing (OIDC) — no long-lived
`NPM_TOKEN` anywhere. The workflow needs `id-token: write`, nothing else.

```bash
pnpm release     # bump versions across packages, then push the tag
git push --follow-tags
```

The tag triggers `.github/workflows/release.yml`, which builds, typechecks, tests, then
publishes every package whose `name@version` is not on the registry yet.

One-time setup on npmjs.com: for each package, add this repository and workflow as a
trusted publisher (Organization/user `imba97`, repository `ci-kit`, workflow `release.yml`).
Without that entry npm has no way to trust the OIDC claim.