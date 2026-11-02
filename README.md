# ci-kit

Reusable building blocks for CI pipelines: AI calls, GitLab releases and packages,
changelog generation, release tagging and a small fetch wrapper.

Use the meta package, or install only the part you need.

```bash
npx @imba97/ci-kit changelog --from v1.0.4 --to v1.0.5 --out notes.md
npx @imba97/ai text --prompt-file prompts/review.md --out review.txt
npx @imba97/ai image --prompt "flat illustration, no text" --size 1280x720 --out image.png
npx @imba97/changelog --from v1.0.4 --out notes.md
```

## Packages

| Package | What it does |
| --- | --- |
| `@imba97/ci-kit` | Meta package, re-exports everything and ships the `ci-kit` CLI |
| `@imba97/ai` | Text and image generation, multi-provider presets, `ai` CLI |
| `@imba97/changelog` | Git history to grouped release notes, `changelog` CLI |
| `@imba97/gitlab` | Releases, generic packages, pipeline schedules, pagination |
| `@imba97/env` | Read `.env`, export without breaking JSON values, redact |
| `@imba97/release` | Semver bump, beta/production tag naming, build numbers |
| `@imba97/http` | fetch with timeout, retry and typed errors |

## Design rules

- Modules do not depend on each other except through `@imba97/http`.
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