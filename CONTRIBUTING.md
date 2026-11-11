# Contributing

Thanks for helping JSeeker support more job sites. This document explains the architecture, the adapter contract, and the exact steps to add a new site such as **Glassdoor** or **Indeed**.

## Requirements

- Node.js >= 20
- Chrome or Brave >= 116
- macOS for the default local OCR Helper (`helper/VisionOCR.swift` is built with `swiftc`)
- A logged-in browser profile for live acceptance tests. Use a dedicated profile, never an anonymous one.

## Setup

```bash
npm ci
npm run build         # bundles extension/ -> dist/
npm run helper:build  # builds the local OCR helper binary
npm test              # unit tests (node:test)
```

Load `dist/` as an unpacked extension. Do not load `extension/` directly: it uses ES module imports and CSS imports that must be bundled.

## Repository map

```text
extension/
  manifest.json          MV3 entry points, host permissions, content scripts
  background.js          service worker: config, scoring, tabs, messaging
  content.js             list-page UI + run orchestration (adapter dispatch)
  scanner.js            BOSS batch scanner (currently imports boss-adapter directly)
  core.js               normalization, scoring rules, jobId/canonicalURL, CV redaction
  sites.js              hostname -> site id, list/detail URL detection, identities
  boss-adapter.js       BOSS DOM adapter (selectors, cards, detail, contact)
  liepin-adapter.js     Liepin DOM adapter
  liepin-coordinator.js Liepin detail-tab batch flow
  llm.js                prompt input, result validation, CV selection
  helper-client.js      extension <-> local Helper transport
  store.js, run-state.js, job-history.js, blacklist.js, ...
helper/                 local HTTP server, model transport, OCR bridge
scripts/                build, CV import, benchmark, browser tests
tests/                  node:test suites and sanitized DOM fixtures
```

Design rule: **site-specific DOM knowledge stays in the adapter**. `core.js`, `llm.js`, background scoring, and persistence should not learn about a new site's markup.

## How a run works

1. A content script (`content.js`) runs on a supported list page. It reads `siteForURL(location.href)` and picks an adapter.
2. The adapter enumerates cards, verifies the detail job ID, reads the JD, and optionally triggers local OCR for garbled/private-font text.
3. The content script sends normalized jobs to the background service worker.
4. The background calls the local Helper (`/evaluate`), which calls the configured LLM provider.
5. Scores are persisted in `chrome.storage.local` (`job_index`, `run`, `contacted_jobs`). Jobs above the threshold are handed back to the adapter to click the contact entry point.

## Adding a new job site

Use a neutral site id such as `glassdoor` or `indeed`. The steps below assume `glassdoor`.

### 1. Register the site (`extension/sites.js`)

Add host detection and a stable identity parser:

```js
export function siteForURL(value) {
  const url = new URL(value);
  if (["glassdoor.com", "www.glassdoor.com"].includes(url.hostname))
    return "glassdoor";
  // ...existing boss/liepin cases
}
```

Add a `glassdoorIdentity(url)` that returns `{ site, source_id, job_id, url }`. Requirements:

- `job_id` must be **namespaced** (`glassdoor:<numeric id>`) so it cannot collide with BOSS or Liepin records. Legacy BOSS IDs intentionally stay unprefixed.
- Strip tracking/query parameters from the canonical URL.
- Return `null` for detail URLs that do not contain a verifiable job id.

Then extend `isListPage()` with the site's search-result URL patterns. Detail pages usually need a separate predicate used by the manifest.

### 2. Create the adapter (`extension/glassdoor-adapter.js`)

Export the functions the orchestrator calls. The BOSS adapter is the reference implementation; copy its structure.

Required surface:

| Export | Purpose |
| --- | --- |
| `cards()` | Return `[{ id, el, link }]` for every unprocessed card, skipping `#jseeker-root`. |
| `cardLocation(card)` | Normalized location text from the card. |
| `detail()` | The visible detail container, or `null`. |
| `detailId()` | Current detail's `job_id`, or `null`. Never guess: verify from the URL or a unique data attribute. |
| `readJob(card)` | Return the normalized raw job object (see below). Throw if the detail cannot be tied to `card.id`. |
| `waitForDetail(id, guard, timeoutMs)` | Poll until the detail for `id` is stable. Call `guard()` so user pause/blocked pages abort promptly. |
| `clickElement(node)` | Safe click helper. |
| `scope()` | Snapshot filters + URL used to detect that the user changed the search scope mid-run. |
| `blockedReason()` | Return a human-readable reason for login walls, CAPTCHAs, rate limits, or unknown dialogs; `null` otherwise. |
| `nextPageWithinResults(guard)` | Load the next page/scroll chunk without leaving the filtered results. |
| `cardSalary(card)` | Optional. Return parsed salary when the card exposes it. |
| `ocrCurrent(card, send, guard, fullJD, onEvidence)` | Optional. Only needed if the site uses private fonts or needs screenshot OCR. |
| Contact-flow exports | `contactButton`, `existingContactButton`, `bonusContactIdentity`, `dismissContactPopup`, `ensureCityFilter` — implement the ones your flow uses, or export `null`-safe stubs and gate the call sites. |

`readJob()` must return at least:

```js
{
  source: "glassdoor",
  source_id: "<site id>",
  job_id: "glassdoor:<id>",
  url: "<canonical url>",
  title, company, salary_raw, salary, location_raw,
  experience_raw, education_raw, jd_raw,
  identity_verified: true,
  extraction_status: "success" | "partial",
  field_sources: { title, company, salary, location, jd },
  quality_flags: [],
  collected_at: new Date().toISOString()
}
```

Rules:

- Verify the detail belongs to the card **after every await** that could navigate (`guard()`, OCR, popup). A changed detail must abort, not be recorded against the old ID.
- Prefer stable selectors and multiple fallbacks (`[data-test]`, semantic attributes) over hashed class names.
- Return `extraction_status: "partial"` when required fields are missing rather than fabricating values.
- Do not read cookies or call non-visible private APIs.

### 3. Wire the dispatch (`extension/content.js`)

```js
import * as glassdoorAdapter from "./glassdoor-adapter.js";
const site = siteForURL(location.href);
const adapter = site === "liepin" ? liepinAdapter
  : site === "glassdoor" ? glassdoorAdapter
  : bossAdapter;
```

Also check `scanner.js`: today it hard-codes the BOSS adapter, and Liepin has its own coordinator. To reuse the generic batch scanner for a new site, refactor `Scanner` to accept an adapter in its constructor (this is a roadmap item) or add a small coordinator that follows `liepin-coordinator.js`. Do not silently run the BOSS flow against another site.

Finally, make `core.js` site-aware if you introduce a new ID format:

- `jobId(url)` currently recognizes BOSS + Liepin.
- `canonicalURL(id)` currently rebuilds BOSS + Liepin URLs.

Add your site to both, and add a unit test for round-tripping `jobId`/`canonicalURL`.

### 4. Manifest and build

`extension/manifest.json`:

- Add `host_permissions` for the site's detail/API hosts.
- Add the list page to the `content.js` `matches` array.
- Add separate content-script entries for detail-page-only features (compare `liepin-detail.js`).
- Keep `run_at: "document_idle"`.

`scripts/build.mjs`:

- Add a new entry point only if you introduce a new content script.
- Bundle it as `iife` for content scripts and `esm` for the background/options/popup.
- Never copy credentials or a real CV into `dist/`.

### 5. Tests

1. **Unit tests** (`tests/*.test.mjs`): URL parsing, `jobId`/`canonicalURL`, salary parsing, `readJob` normalization, blocked-page detection.
2. **Sanitized DOM fixture**: save only the structural markup needed for selectors, with synthetic text and no personal data, then drive it with a browser test like the existing `scripts/*_browser_test.py`. Do not commit a captured page containing a real CV, recruiter names, cookies, or account IDs.
3. **Live acceptance**: logged-in dedicated profile, explicit filters, threshold, and run size. Report only status, model ID, and scores.

```bash
npm test
npm run build
npm run test:setup
```

### 6. Checklist

- [ ] `siteForURL`, `isListPage`, and an identity parser are unit-tested.
- [ ] `job_id` is namespaced and canonical URLs drop tracking parameters.
- [ ] `readJob` verifies identity after every navigation/await.
- [ ] `blockedReason` covers login, CAPTCHA/anti-bot, rate limit, and unknown modal dialogs.
- [ ] Contact clicks are preceded by an identity re-check and are not repeated on unconfirmed results.
- [ ] `manifest.json` permissions are minimal (only hosts actually used).
- [ ] No real CV, credentials, cookies, or personal data in code, fixtures, screenshots, or docs.
- [ ] `npm test && npm run build` pass.
- [ ] README "Supported sites" and the roadmap are updated.

## Notes for Glassdoor and Indeed

- Both are international sites. Expect English UI text, different salary formats (`$120K–$150K/yr`), and location/remote filters that do not map to `MAJOR_CITIES`. `parseSalary` currently understands Chinese `k/千/万` formats; add format coverage and tests before relying on salary filters.
- Login walls and bot protection are common. Detect them in `blockedReason` and pause instead of retrying aggressively.
- Job IDs may appear in the URL path, query string, or embedded JSON. Prefer the canonical job-detail URL and verify it on the detail page.
- Application flows differ (Easy Apply, external redirect, company ATS). Decide early whether "contact" means opening an apply dialog, an external tab, or merely marking the job as ready to apply. Keep the semantics explicit in the adapter and in the CSV application-status column.
- Indeed often renders results client-side and virtualizes lists. Use ID-based scroll/next-page detection (see `nextPageWithinResults`) rather than counting nodes.

## Privacy and safety rules

These are non-negotiable:

- Never commit a real CV. `extension/profile.local.json` is gitignored; only `extension/profile.example.json` may be committed.
- Never commit `.env`, tokens, pairing keys, `helper-pairing.json`, or `dist/`.
- Redact contact data before any model call. When adding English CV support, extend `redactCV` and its tests rather than relaxing the check.
- Do not automate login, CAPTCHA solving, or anti-bot evasion.
- Do not send site cookies or private API payloads anywhere.

## Pull requests

- Keep changes scoped; a new adapter should not rewrite the scoring pipeline.
- Include tests and the exact commands you ran.
- Describe any real-world acceptance run (site, profile type, filters) without including personal data.
- Update both `README.md` and `README.zh-CN.md` when behavior or setup changes.
