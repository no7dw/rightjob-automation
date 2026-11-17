# JSeeker Premium

Standalone **hosted scoring / monetization** package for JSeeker.

Community `main` does **not** need this folder. Premium lives here so it can:

1. stay private / separate from the open-source community line
2. be attached as a **git submodule** (recommended) or a plain directory on `prod-pay`

## What is inside

| Path | Role |
| --- | --- |
| `helper/` | Pay store, Resend mail, admin page, server route registration |
| `extension/` | Pay config, cloud client, options account UX, background pay runtime |
| `tests/` | Premium unit/integration tests |

## Host integration (this monorepo)

- Helper: `helper/server.mjs` loads `premium/helper/register.mjs` only when `PAY_MODE=1`
- Extension build: `scripts/build.mjs` aliases `@jseeker/premium` → `premium/extension` (pay) or `extension/community-stubs` (community)
- Local dry-run: `./restart.sh pay` + `npm run build:pay:local`

## Use as a git submodule

From a **separate private repo** that contains only this `premium/` tree:

```bash
# in community monorepo (example)
git submodule add git@github.com:YOUR_ORG/jseeker-premium.git premium
git submodule update --init --recursive

PAY_MODE=1 CLOUD_BASE_URL=https://pay.example.com npm run build:pay
./restart.sh pay
```

On machines that only build community:

```bash
# do not init submodule
npm run build
```

`PAY_MODE=1` without `premium/` fails fast with a clear error.

## Split this folder into its own repo later

```bash
# one-time extraction sketch
cd /path/to/rightjob-automation
git subtree split -P premium -b premium-split
mkdir -p ../jseeker-premium && cd ../jseeker-premium
git init
git pull ../rightjob-automation premium-split
# add remote + push, then in monorepo:
# git rm -r premium && git submodule add <remote> premium
```

## Env (server)

See host root `.env.example` pay section: `PAY_MODE`, `APP_PUBLIC_URL`, `RESEND_*`, `ADMIN_PASSWORD`, `OPENAI_*`, `PAY_DB_PATH`.
