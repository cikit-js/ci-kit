# ci-kit

Reusable building blocks for CI pipelines: AI calls, GitLab releases and packages,
changelog generation, release tagging and a small fetch wrapper.

Use the meta package, or install only the part you need.

```bash
npx @imba97/ci-kit changelog --from v1.0.4 --to v1.0.5 --out notes.md
npx @imba97/ci-kit-ai text --prompt-file prompts/review.md --out review.txt
npx @imba97/ci-kit-ai text --prompt-file prompts/write.md --json --max-tokens 16000 --retries 0 --out article.json
npx @imba97/ci-kit-ai image --prompt "flat illustration, no text" --size 2560x1440 --out image.png
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

## AI providers

Text and image are separate registries, because vendors and models rarely match:

```
src/providers/
├── index.ts          # resolveTextProvider / resolveImageProvider
├── types.ts
├── text/
│   ├── dashscope.ts  # DashScope compatible mode, ZHIPU/GLM-5.3-Flash
│   └── openai.ts     # any OpenAI compatible endpoint + factory
└── image/
    ├── seedream.ts   # Volcengine Ark Seedream
    └── dashscope.ts  # DashScope image, 1280*720 style sizes
```

| Variable | Default | Meaning |
| --- | --- | --- |
| `AI_TEXT_PROVIDER` | `dashscope` | registry key in `text/` |
| `AI_IMAGE_PROVIDER` | `seedream` | registry key in `image/` |
| `AI_API_KEY` | — | key used by text providers |
| `AI_IMAGE_API_KEY` | — | key used by image providers |
| `AI_TEXT_MODEL` | provider default | overrides the model without editing the package |
| `AI_IMAGE_MODEL` | provider default | overrides the image model |
| `AI_IMAGE_SIZE` | provider default | default image size when a call omits `size` |

Adding a provider is one file plus one line in the matching `index.ts`; the CLI and the
calling project do not change. Public sizes are always `WxH`, and each provider declares
its own `sizeSeparator` when the vendor wants something else.

### Library usage

```ts
import { image, text } from '@imba97/ci-kit-ai'

const reply = await text({
  prompt: 'Summarise this diff',
  system: 'You are a release manager.',
  maxTokens: 1024,
  retries: 0 // paid call: never resend after an unknown outcome
})

const picture = await image({ prompt: 'flat illustration, no text', size: '2560x1440' })
```

`text()` forwards `maxTokens`, `temperature` and `json` (as `response_format`) when set,
reports `usage` and `finishReason`, and fails when the provider ends with a reason other
than `stop` — a truncated string is not a successful answer. `json: true` throws on a
provider that cannot honour it instead of silently ignoring the request.

`image()` requires exactly one image in the response, surfaces item level errors by code
only, and rejects payloads that are neither PNG nor JPEG.

### Errors

Failures are `AiError` with a stable `kind` (`auth`, `quota`, `request`, `network`,
`server`, `output`, `config`), plus `provider`, `model`, `status` and `retryable`.
Branch on `kind`, never on the message. Messages never contain the key, the request
body or the provider payload; `error.describe()` gives one log-safe line.

### Retries and paid calls

The transport retries `408`, `429`, `5xx` and network errors twice by default. Pass
`retries: 0` for paid or non-idempotent generation: the provider may already have
completed the request, and a retry charges again. Timeouts are reported as
non-retryable for the same reason.


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

Versioning is `bumpp -r`: it bumps every package, commits, tags, and pushes.

```bash
pnpm release        # choose patch/minor/major, all packages move together
```

Pushing the tag triggers `.github/workflows/release.yaml`, which installs, typechecks,
tests, builds, then runs:

```bash
pnpm -r publish --access public --no-git-checks
```

**Publishing must go through pnpm, not npm.** npm does not understand the workspace
protocol: it writes `"@imba97/ci-kit-ai": "workspace:*"` straight into the tarball, and
installing the published package then fails to resolve any internal dependency.
`pnpm publish` rewrites `workspace:*` to the real version at pack time:

```bash
pnpm pack                       # then look at package/package.json inside the tarball
# "@imba97/ci-kit-ai": "0.1.1"  ← real version, not workspace:*
```

Authentication uses npm Trusted Publisher (OIDC), so no `NPM_TOKEN` exists anywhere:
`permissions: id-token: write` in the job is the only requirement, and pnpm exchanges
it for a short-lived credential. Node ships its own npm; the publish path does not
depend on the npm version.

One-time setup on npmjs.com: for each package add this repository and workflow as a
trusted publisher (user `imba97`, repository `ci-kit`, workflow filename `release.yaml`).