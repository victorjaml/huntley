# huntley — Technical Design

How huntley works: its components, the data that flows between them, the state it keeps, and how it behaves when something fails. It describes the system as it is now and should change whenever the code does.

What huntley must do is specified in [prd.md](prd.md). Installing and running it is covered in the [README](../README.md). Tunable values and their defaults live in `config/*.example.yml`; source-specific details live in the comment block at the top of each source module.

---

## 1. Overview

### 1.1 Execution model

huntley is a Node.js (ESM) command-line program. Each command runs as one process, does its work, and exits. There is no server, no database, no daemon and no inbound network listener. Everything that persists between runs is a file under `data/`.

| Command | What it does |
|---|---|
| `run` | Catch up since last success, rank, write a complete local report, and email a shorter summary if configured |
| `daily` | Alias for `run` |
| `weekly` | Sync the tracker, review what was shown against what was added, and email a proposed preference change |
| `weekly --apply <id>` | Apply a stored proposal without the email click |
| `sync` | Read the tracker sheet back and apply any approvals |
| `doctor` | Check configuration, credentials, dependencies and each source's prerequisites |
| `setup` | Create config files from the examples and generate the link-signing secret |

`--dry-run` works on `run`, `weekly` and `sync`: the work happens, nothing is sent, and durable catch-up state is not changed (see 9.3). Scheduler and Apps Script are optional.

### 1.2 Architecture

```
                         ┌──────────────────────────── huntley run ──────────────────────────────┐
config/huntley.yml ────► │ lock ─► migrate ─► sync ─► collect (per-unit windows) ─► ingest ledger │
config/preferences.yml ─►│   ─► pending ─► prefilter ─► cap ─► rank ─► local report ─► optional   │
config/watchlist.yml ───►│      email. Collection, publication and email are independent states.  │
.env (secrets) ────────► └───────┬───────────────────────┬──────────────────────────────┬────────┘
                                 │                       │                              │
            board lanes (in-process)              HTTP sources (in-process)       email transport
            src/sources/boards/                   dataset, freehire, YC pages,           │
            watchlist, funds, ATS sweeps          LinkedIn, Wellfound                     ▼
                                 │                                              inbox ─[Add]─► Apps Script
                                 ▼                                                                    │
data/  progress.json · roles.json · runs/<id>/ · seen.tsv · collection/ · funds/ · active-boards.json ·                                 │
       cache/ · tracker.json · proposals/ · digests/                                          Google Sheet
                                 ▲                                                                    │
                                 └──────────── published CSV, read by the next sync ─────────────────┘
```

### 1.3 Code layout

| Path | Contents |
|---|---|
| `bin/huntley.mjs` | Argument parsing and command dispatch |
| `src/run.mjs`, `src/weekly.mjs` | The two pipelines (`daily.mjs` re-exports `run`) |
| `src/state/` | Catch-up windows, lock, role ledger, commit journal, migration |
| `src/config.mjs`, `src/lib/paths.mjs` | Config loading and validation; every path huntley reads or writes |
| `src/lib/lanes.mjs`, `src/lib/log.mjs` | The parallel lane runner; logging |
| `src/normalize.mjs`, `src/dedupe.mjs` | The job record; canonical URLs and ids; cross-source dedupe |
| `src/sources/` | Collection lanes, `boards/` providers + HTTP, `funds/` for VC portfolios |
| `src/rank/` | Title matching, location parsing, prefilter, per-company cap, prompt, model call, watchlist bonus |
| `src/setup.mjs`, `src/setup/` | Install bootstrap; one-shot resume → `preferences.background.summary` |
| `src/digest/`, `src/email/` | HTML and text rendering; email transports |
| `src/sheet/` | Signed links; tracker read-back and approvals |
| `src/memory/` | Proposal generation; the only writer of `preferences.yml` |
| `apps-script/Code.gs` | The Add/APPROVE endpoint, deployed to Google Apps Script |
| `src/sources/boards/` | In-tree ATS providers, HTTP stack, `scanBoards` / directory sweeps |
| `deploy/` | systemd units for scheduling |

---

## 2. Configuration

### 2.1 Files and loading

| File | Contents | Written by |
|---|---|---|
| `config/huntley.yml` | Sources and their settings, ranking, digest, email, sheet | the operator |
| `config/preferences.yml` | Role terms, focus keywords, exclusions, locations, company blocks, background, notes | the operator, or an approved proposal |
| `config/watchlist.yml` | Tracked companies, VC portfolio boards, fund portfolios | the operator |
| `.env` | Secrets: link-signing key, email credentials, sheet CSV URL | the operator; `setup` generates the signing key |

`loadConfig()` loads `.env` (without overriding variables already set), reads the YAML files, expands `${VAR}` references from the environment, deep-merges `huntley.yml` over built-in defaults, and validates. Validation checks list shapes in `targets` (a key inserted mid-list re-parents the items after it while still parsing), that exclusion exceptions refer to real exclusions and keyword groups, the location allow-list and remote policy, and it names retired keys. Any problem throws a `ConfigError` listing all of them.

`HUNTLEY_DATA_DIR` and `HUNTLEY_CONFIG_DIR` redirect every path in `src/lib/paths.mjs`. The test suite uses them to run against scratch directories.

### 2.2 Board collection configuration

Board lanes read `config/watchlist.yml` and preferences in-process (no generated portals YAML). Early title filtering uses `scannerTitleTerms()` → `title-keywords` so collection keeps a **superset** of what Huntley's prefilter would keep:

- **Positive terms:** one word per role term (longest word, `*` removed), substring match.
- **Negative terms:** exclusions anchored with `word:` or `stem:` so "intern" does not drop "Internal Tools Engineer".
- **Exclusions with exceptions are omitted** from the early filter (exceptions are applied later by Huntley prefilter).
- **No location filter at collection** — Huntley parses locations in prefilter.

---

## 3. Data

### 3.1 The job record

Every source produces the same record, built by `toJob()` in `src/normalize.mjs`, which returns null for anything without a usable URL and title.

| Field | Meaning |
|---|---|
| `id` | Stable id, assigned by dedupe |
| `url` | Canonical posting URL: lowercased host, `www.` and fragment removed, `https`, tracking parameters stripped, remaining parameters sorted |
| `title`, `company`, `location`, `description` | As the source gave them; description truncated |
| `companyKey` | Company folded for matching: lowercased, accents and punctuation removed, legal suffixes (inc, llc, labs…) dropped |
| `source`, `sourceDetail` | The lane (`watchlist`, `portfolio`, `ats_sweep`, `freehire`, `linkedin`, `wellfound`) and the board or provider behind it |
| `postedAt`, `firstSeen` | Posting date when known; the date huntley first saw it |
| `watchlist` | The company is a tracked company |
| `fingerprint` | Job-description fingerprint, when a provider supplied one |

Stages add fields as the record moves through the pipeline: `board` (the job board behind the posting, when a source knows it), `companyAliases` (4.2.4), `workplace`, `titleKeywords`, `keywordScore` and `heuristic` (4.5), `moreAtCompany` (4.6), `score`, `why` and `heuristicOnly` (4.7), `modelScore` and `bonus` (4.8).

**Job ids** are the first 16 hex characters of a SHA-256 over the posting's ATS requisition identity (`greenhouse:acme:4012345`), or over its canonical URL when no identity can be parsed. The id survives tracking-parameter changes and is what an Add link carries.

### 3.2 State

| Path | Contents | Written by |
|---|---|---|
| `progress.json` | Schema, per-unit checkpoints, committed run IDs, pending email | `run`, after successful unit coverage |
| `roles.json` | Canonical role ledger: identity aliases, decisions, publication and email IDs | `run`, after ingest and again after publication |
| `runs/<timestamp>-<uuid>/` | Immutable run dir: raw.json, report, exports, commit journal, manifest | `run`; preview runs go under `runs/preview/` |
| `seen.tsv` | Legacy `id, date, company, title` for judged roles. Append-only; not a coverage checkpoint | `run`, after local publication |
| `runs/<date>-raw.json` | Compatibility snapshot of collected jobs | `run`; `--no-scan` can replay date-keyed or run-id snapshots |
| `runs/<date>-shown.json` | Ranked roles with `publishedLocally` / `inEmail`, plus rejections. Console delivery never sets `inEmail` | `run`; read by weekly |
| `runs/<date>-shown.dryrun.json` | The same record for a dry run, kept apart so a preview never alters delivery history | `run --dry-run` |
| `runs/runs.jsonl` | One summary line per real run | `run` |
| `collection/` | Board observations (atomic per completed board), sweep checkpoints, ATS company-list cache. Uncommitted observations are not pruned by age on recovery | board collectors |
| `careerops/` | Pre-migration scanner state (unread; safe to delete) | — |
| `active-boards.json` | Boards to read directly, with first and last hit dates | daily |
| `funds/lists/<fund>.json`, `funds/resolved.json` | Each fund's company list; website → board resolutions | the fund lane |
| `cache/board-names.json` | Board → company name and aliases | the dataset lane |
| `tracker.json` | Local copy of the sheet's tabs | sync |
| `proposals/<id>.json`, `proposals/applied.jsonl`, `proposals/preferences.before-<id>.yml` | Proposals, the applied-approvals ledger, pre-apply backups | weekly, apply |
| `digests/` | Rendered digests and proposals, including dry runs | daily, weekly |

Caches carry their own `checkedAt` times and are safe to delete; the next run rebuilds them, more slowly.

---

## 4. The run pipeline

`runHuntley()` in `src/run.mjs` (`huntley daily` is an alias) runs the steps below in order. Collection windows come from per-unit checkpoints plus `collection.overlap_hours`, not from fixed 1–3 day caps. Every step before the send catches its own failures and records a warning, which the digest renders as a "Run was degraded" panel (section 7). Exit `0` means complete retrieval and requested delivery; `2` means useful results with partial coverage or unscored backlog; `1` means lock, persistence, or requested email failure.

### 4.1 Sync

`syncTracker()` reads the tracker sheet (section 5.3) and applies any approval clicked since the last run. When an approval is applied, `preferences.yml` is reloaded so the rest of the run uses the changed preferences. A dry run reads the sheet but writes nothing and applies nothing.

### 4.2 Collection

`collectAll()` builds a lane for each enabled source and hands them to `runLanes()`, which starts all of them at once with `Promise.allSettled`. Every lane returns jobs in memory. A rejected lane is logged, listed as a failed source and added to the warnings; the others are unaffected. Lane timings are logged.

After lanes settle, the coordinator merges unconsumed prior observations from `data/collection/` irrespective of age so a crash after collection does not lose roles. `roles.json` is the capture ledger; `seen.tsv` remains a compatibility processing ledger, not a coverage checkpoint.

#### 4.2.1 Board collection (`src/sources/boards/`)

Providers live under `src/sources/boards/providers/` with an explicit registry (`registry.mjs`). `scanBoards(entries, opts)` fetches boards with bounded concurrency, applies the early title/freshness filters, returns `{ jobs, errors, stats }`, and writes an atomic observation file **as each board finishes**.

ATS directory sweeps use `scanDirectory({ ats, ... })` (Greenhouse / Lever / Ashby / Workday / iCIMS) with Huntley-owned checkpoints and dead-board state under `data/collection/sweeps/`.

**Dry runs.** `prepareScan({ dryRun: true })` points observation writes at a temporary tree; `endScan()` deletes it. Seen state is not consumed.

**Discovery.** `huntley discover-board <Company> [--write]` probes ATS boards (print-only by default; `--write` appends to `config/watchlist.yml`).

See [`docs/collection-provider-inventory.md`](collection-provider-inventory.md) and [`docs/collection-parity-report.md`](collection-parity-report.md).

#### 4.2.2 Watchlist and portfolio boards

The watchlist lane calls `scanBoards` over enabled `tracked_companies`. The portfolio-boards lane does the same for Getro/Consider boards from `portfolio_boards`.

#### 4.2.3 ATS dataset

`src/sources/ats-dataset.mjs` reads the daily export of [job-board-aggregator](https://github.com/Feashliaa/job-board-aggregator): a manifest listing gzip-compressed JSON files of about 25,000 postings each, covering Greenhouse, Lever, Ashby, Workday, BambooHR, iCIMS and Paylocity.

1. **Download.** Fetch the manifest, then the files with bounded concurrency. Each file is decompressed, parsed and filtered before the next is held, so memory holds only recent roles: the full export does not fit in the default heap.
2. **Filter.** Keep rows whose ATS is in `sources.ats_dataset.ats` and whose `first_seen` is within `since_days`. `first_seen` stands in for the posting date, which the dataset does not carry.
3. **Board.** Attach the board from the row's ATS and company slug (`job-boards.greenhouse.io/<slug>`, `jobs.lever.co/<slug>`, …), falling back to the URL for Workday. Greenhouse postings are often served from a company domain, so the URL alone is not reliable.
4. **Prefilter.** Only survivors leave the lane; the dataset holds tens of thousands of recent roles.
5. **Name.** `resolveCompanyNames()` (4.2.4) replaces slug names, then the prefilter runs again so company blocks apply to the real names.

The manifest's `last_updated` is compared with `max_age_hours`. When the dataset is stale or unreachable, the lane adds a warning and runs `scanDirectory` for each vendor in `fallback_sweep`, in parallel.

#### 4.2.4 Company names

`src/sources/board-names.mjs` resolves a real company name for each board behind a surviving dataset role, once per board:

| Vendor | Source of the name |
|---|---|
| Greenhouse | `boards-api.greenhouse.io/v1/boards/<slug>` → `name` |
| Workday | The job-detail API (`/wday/cxs/<tenant>/<site>/job/...`) → `hiringOrganization.name` with leading internal codes stripped, plus the brand in the career-site name from `jobPostingInfo.externalUrl` |
| Others | The board page's `<title>`, with vendor and "Jobs"/"Careers" boilerplate removed |

Up to three roles per board are tried, since a role may have closed since the dataset's crawl. Results, including failures, are cached in `cache/board-names.json`; failures are retried sooner. Every name a board goes by, including its slug, is stored on the job as `companyAliases`.

#### 4.2.5 Active boards

`src/sources/active-boards.mjs` keeps `data/active-boards.json`, keyed by board URL, with vendor, provider (for systems on employers' own domains), company name, first and last hit dates, and a hit count. After ranking, the board behind every role scoring at or above the threshold is recorded (4.8); the board comes from `job.board` or is extracted from the URL. The lane selects boards whose last hit is within `within_days`, skips boards already on the watchlist, and scans them in-process via `scanTracked` with a `since_days` floor.

#### 4.2.6 Board recognition

`src/sources/funds/boards.mjs` recognises links to 16 vendors — Greenhouse, Ashby, Lever, Workable, Gem, Rippling, Jobvite, SmartRecruiters, BambooHR, Breezy, Recruitee, Pinpoint, Teamtailor, Personio, JazzHR and Workday — including escaped links inside embedded JSON and Greenhouse embed URLs. Each is emitted as the `careers_url` shape the matching in-tree provider's `detect()` accepts, and path segments that sit where a slug would (`embed`, `api`, `jobs`…) are rejected. `extractBoards()` returns every board linked from a page, ordered by how often each is linked. `boardFor(vendor, slug)` builds a board from a source that names one without linking it.

#### 4.2.7 Fund portfolios

`src/sources/funds/` turns a VC fund's public portfolio into boards to scan. Each fund in `watchlist.yml` names an adapter `kind`:

| Kind | Reads | Produces |
|---|---|---|
| `yc` | The yc-oss company directory, one JSON file | Active, hiring companies with website and YC slug |
| `ats_links` | A page linking to job boards or postings | One company per board |
| `company_links` | A portfolio page linking to company websites | One company per external site, named from its card or logo alt text; infrastructure and social hosts are excluded |
| `wordpress` | A WordPress post type under `wp-json/wp/v2/`, paged | Title and link of each post |

`planFundScan()` then runs four steps:

1. **List.** Run each adapter, caching its list per fund for a day. A company stays in the cached list for a period after it was last seen, so a page that shows only recent jobs accumulates the portfolio. A failed fetch reuses the last list and adds a warning.
2. **Merge.** One record per company across funds, keyed by site, then board, then name, remembering every fund it belongs to.
3. **Resolve.** For each company with a website and no board, `resolveWebsite()` fetches the homepage, then up to two careers links it offers (same-site links whose path or text says careers, jobs, join us, hiring), or `/careers` and `/jobs`. The most-linked board wins. If none is found, `guessBoard()` probes the Greenhouse, Ashby and Lever APIs for a slug derived from the domain, or from a company name of eight or more letters, and accepts a board only if it names itself as the company. Resolutions are cached in `funds/resolved.json` with separate lifetimes for found, not found and unreachable. Resolution runs against a time budget; companies left over wait for a later run. Boards found without a company name are named from the board.
4. **Emit.** Boards not already on the watchlist are scanned in-process with a date floor. YC companies without a board are read from YC instead.

**YC job pages.** `src/sources/funds/yc-jobs.mjs` fetches `ycombinator.com/companies/<slug>/jobs` for those companies, with bounded concurrency and a time budget, and parses the Inertia page state in the `data-page` attribute. YC gives only fuzzy ages ("about 1 month"), which are converted to an approximate `postedAt`; roles older than `yc_max_age_days` are dropped. YC writes countries as ISO codes, which are spelled out before location parsing ("CA / Remote (CA)" becomes "Canada / Remote (Canada)").

#### 4.2.8 freehire

[freehire](https://freehire.me) is a public job-search API over 236 sources. It is read by two lanes.

**Feed** (`src/sources/freehire-feed.mjs`). Reads everything freehire first recorded (`open_within_days`) in the configured countries:

1. Request `/api/v1/jobs/facets` for per-source counts, and remove excluded sources: those the dataset covers, those with their own lanes, and aggregators.
2. Group sources so each query stays under freehire's 10,000-row offset limit.
3. Page each group through `/api/v1/jobs/search`, 100 rows at a time, sorted by `created_at` ascending so rows arriving mid-run cannot shift earlier offsets.
4. Convert each row to a job, strip freehire's tracking parameter, and attach its board: from the URL when it names one, otherwise from freehire's `external_id` (`<board>:<job id>`). Oracle, iCIMS, Avature, SuccessFactors and Phenom boards are built with an explicit provider id, because they run on employers' own domains.
5. Prefilter each page as it arrives, keeping only survivors.

Requests identify the project in `User-Agent`, pause when `X-RateLimit-Remaining` runs low, and back off on 429 or 5xx. A response listing `meta.ignored_params` fails the lane, because freehire answers an unknown filter with the unfiltered catalogue.

**Search** (`src/sources/freehire.mjs`). Runs the configured keyword queries against `/api/v1/agent/jobs/search`, which returns full job descriptions. Rows flagged `fake_freshness` (reposts presented as new) are dropped.

#### 4.2.9 Built In and Hacker News

Both use in-tree `job_boards` providers via `scanTracked`. Built In gets one entry per configured city site (`www.builtinla.com`, …) with the configured categories and a page cap; only category pages are read, since keyword search and percent-encoded paths are disallowed by its robots.txt. Hacker News reads the current month's "Ask HN: Who is hiring?" thread and runs with no date floor, because the thread is posted once a month.

#### 4.2.10 LinkedIn and Wellfound

Both read public pages in-process and share `residentialCheck()`, which disables the lane when a CI variable (`GITHUB_ACTIONS`, `CI`, `GITLAB_CI`, and others) or `HUNTLEY_RUNTIME=datacenter` is set.

**LinkedIn** (`src/sources/linkedin.mjs`) requests the `jobs-guest` search endpoint once per query, location and page, with a delay and jitter between requests, and parses the returned `<li>` cards. The whole plan is sent unless it exceeds `request_limit`. The lane stops at the first 429.

**Wellfound** (`src/sources/wellfound.mjs`) requests `/role/l/<role>/<city>` and `/role/r/<role>` pages and parses the Apollo state in `__NEXT_DATA__`: startups, their highlighted roles, locations, `liveStartAt`, compensation and description.

- **Plan.** Every role × location, rotated by date. All first pages are read before any second page.
- **Unknown roles.** A page whose state lacks `seoLandingPageRoleAndLocation` (or `seoLandingPageRoleRemote`) is Wellfound's fallback for an unrecognised role, so its results are discarded with a warning.
- **Filtering.** Roles older than `max_age_days` are dropped, since pages are sorted by relevance, not date.
- **Stopping.** A 403 or 429 stops the lane.

### 4.3 Dedupe

`dedupe()` in `src/dedupe.mjs` assigns ids and collapses copies of one role across sources. Each job produces up to four alias keys:

1. Canonical URL.
2. ATS requisition identity, parsed from the URL for Greenhouse (including `gh_jid`), Lever, Ashby, Workday, SmartRecruiters, Workable, Recruitee, Breezy, Jobvite and BambooHR.
3. Company key plus folded title.
4. Company key plus job-description fingerprint.

Records are indexed by every alias; a job matching several existing records merges them all. The surviving copy is chosen by:

1. A non-aggregator URL over an aggregator one (LinkedIn, Wellfound, Indeed…).
2. Then source rank: watchlist, portfolio and ATS sources, freehire, then LinkedIn and Wellfound.
3. Then the richer record: a description counts more than a date.

The survivor takes missing `postedAt`, `description`, `fingerprint` and location from the other copy. `watchlist` is true if either copy had it, `firstSeen` takes the earlier date, and the other copy's URL is kept in `altUrls`.

### 4.4 Seen filter

Roles whose id is in `seen.tsv` are removed. On a successful send, every ranked and capped job is marked seen, so roles past `digest.max_rows` and scores below the threshold are not re-offered the next day.

### 4.5 Prefilter

`prefilter()` in `src/rank/prefilter.mjs` returns kept jobs and `{ job, reason }` rejections. Each job is checked in this order, and the first failing rule is the reason:

1. **Company block.** The company name and every alias are compared with `filters.block_companies`: as whole words, or, for block entries of five letters or more, with spaces and punctuation removed ("Scale AI" blocks "scaleai").
2. **Excluded title** (below).
3. **Location** (below). Rejected if the place is outside the accepted places, or if the job is remote and remote roles are excluded.
4. **Role term.** The title must contain one of `targets.role_terms`.
5. **Keyword floor.** The title must contain at least `targets.min_keyword_score` focus keywords.
6. **Seniority and content** exclusions from `filters`.

**Title matching** (`src/rank/title-match.mjs`). Terms compile to case-insensitive, Unicode-aware, whole-word patterns. A trailing `*` matches the start of a word, and a space also matches a hyphen, slash or underscore. `matchTitle()` returns:

| Result | Meaning |
|---|---|
| `excluded` | Matched exclusion terms, minus any cancelled by an exception that also appears in the title. An exception can name a keyword group (`@robotics`) |
| `roles` | Matched role terms |
| `keywords`, `groups` | Matched focus keywords and their groups. Overlapping matches count once, longest first |
| `score` | The number of distinct keywords |

**Location parsing** (`src/rank/places.mjs`). `classifyLocation()` returns `office`, `remote`, `unknown` or `other`:

1. **Split into segments** on `·`, `;`, `|`, `/`, `&`, "and", "or", and bracketed work-mode notes. Street addresses and ZIP codes are removed.
2. **Group each segment's comma-separated parts into places,** starting a new place when a city follows a state or country ("San Francisco, CA, USA, New York, NY, USA" is two places).
3. **Place each part.** Built-in tables cover US states and their codes, US cities for bare city names, named city groups (NYC's boroughs and neighbourhoods), foreign countries and regions, Canadian provinces, and foreign hub cities.
4. **Match against `location.allow`.** An entry can be a state, a city in a state, or a city. Context settles ambiguity: "Portland, ME" does not match "Portland, OR", and "CA" after a Canadian city is Canada.
5. **Remote** counts only when it is in the US. A foreign remote segment is `other`, and a bare country with no city counts as remote.

A job with any accepted office place is `office`.

**Heuristic.** Each kept job gets a 0–100 score used to order jobs before the model sees them and as the fallback score. It adds points for:
- being on the watchlist;
- each focus keyword, up to a cap;
- a preferred level;
- an accepted office;
- freshness;
- having a description.

It subtracts points for remote under `rank_lower` and for deprioritised title words. Kept jobs are sorted by it, highest first.

### 4.6 Per-company cap

`capPerCompany()` in `src/rank/per-company.mjs` walks the kept jobs in heuristic order and keeps the first `rank.max_per_company` for each company key; watchlist companies get the same limit. A kept job from a company with further matches carries `moreAtCompany`. The rest are returned as `capped`: they are not ranked, they are marked seen with the ranked jobs after a successful send, and they appear in the run record as rejections giving the cap as the reason.

### 4.7 Ranking

`rankJobs()` in `src/rank/llm.mjs` scores roles that survive filters and the per-company cap with a headless agent CLI. `rank.max_llm` is null (all eligible roles), a nonnegative cap on **new** model submissions, or zero. Cache hits do not consume the budget.

- **CLI.** `rank.cli` names one of `claude -p`, `gemini -p`, `codex exec`, `opencode run` or `cursor-agent -p`; if it is not installed, the first of those found on `PATH` is used, and with none the run is ranked heuristically. Detection itself times out so a hung `which` cannot stall the run. `rank.model` is passed to `claude` and `gemini`.
- **Deadline and concurrency.** Ranking starts a `rank.total_timeout_ms` deadline that covers CLI detection, cache lookup, and model calls. Batches of `rank.batch_size` are dispatched through a worker pool of `rank.concurrency` (1–4). Each call uses the smaller of `rank.timeout_ms` and remaining deadline. At deadline, in-flight calls are cancelled and unfinished roles become `past_deadline`.
- **Outcomes.** Every role that reaches ranking gets exactly one `rankStatus`: `model`, `cache`, `over_budget`, `past_deadline`, or `failed` (with `failureReason` when failed). `heuristicOnly` remains true for the last three. Aggregate counts and per-batch timing land in the run summary / `*-rank.json` telemetry (no prompts or raw replies).
- **Prompt** (`src/rank/prompt.mjs`). Candidate brief plus each job via shared `renderJob()` helpers (also used for the rank-cache key). Descriptions use a section-aware excerpt up to 4,000 characters. Metadata-only jobs are labelled in the prompt; posting text is treated as untrusted data.
- **Parsing.** `extractJson()` finds the first JSON array. Validation rejects foreign ids, duplicate expected ids that disagree on score, null/string/out-of-range scores, and short reasons without clamping. Duplicate expected ids that agree on score keep the first row. Valid siblings in a partial response are kept; missing expected ids become `not_returned` (or `id_mismatch` when a returned id is a near-miss).
- **Cache.** Versioned entries under `data/cache/rank/` keyed by brief + rendered job + CLI/model + prompt version. Dry runs may read/write this cache without touching seen/delivery state.
- **Fallback.** Budget overflow, deadline, and failures keep heuristic scores and render with an asterisk. Digest warnings separate provider failures from intentional budget overflow.

### 4.7b Description enrichment

After the company cap and before rank-cache lookup, `enrichDescriptions()` optionally fetches missing Greenhouse / Lever / Ashby descriptions (`enrichment.*`). Existing descriptions (collection sidecars, freehire, wellfound) are never overwritten empty. Unsupported hosts stay metadata-only. Digest rows without a description always show “Limited evidence: title, company and location only”.

Career-ops descriptions are no longer written through TSV sidecars. Providers return description text on each job; enrichment may still fetch detail pages when evidence is missing.

### 4.8 Bonus, threshold and order

- **Bonus.** `applyWatchlistBonus()` adds `rank.watchlist_bonus` to model-scored watchlist jobs, capped at 5, recording the model's score as `modelScore` and the bonus as `bonus`. Heuristic scores already include the watchlist and get no bonus.
- **Threshold.** Jobs below `rank.min_score` are dropped from the digest and counted.
- **Order.** Highest score first, with a stable sort so ties keep heuristic order. The list is cut at `digest.max_rows`.
- **Learn boards.** Unless the run is a dry run or a `--no-scan` replay, the boards behind model-scored jobs at or above the threshold are recorded in the active-boards ledger.

### 4.9 Rendering, delivery and records

**Rendering** (`src/digest/render.mjs`) produces HTML and plain text with the same structure:

1. **Headline.** The number of matches, how many are from the watchlist, and postings scanned across sources.
2. **Warnings panel,** when the run was degraded.
3. **One row per job:** title linking to the posting, company with "+N more matching roles" and a watchlist badge showing the bonus, location, age and source, the reason, the score, and an Add button or the reason there is none.
4. **Footer:** the run's arithmetic (fetched, duplicates merged, filtered, beyond the per-company cap, below threshold, shown), sample rejection reasons, and a note that Add records an intent to apply.

The HTML uses tables and inline styles with no external resources, so mail clients that strip `<style>` render it. Every interpolated value is HTML-escaped. A day with no matches renders the same structure with a headline saying so.

**Transports** (`src/email/send.mjs`):

| Transport | Configured with |
|---|---|
| `console` | Nothing; writes the digest to `data/digests/` |
| `resend` | `RESEND_API_KEY` |
| `mailjet` | `MAILJET_API_KEY`, `MAILJET_API_SECRET` |
| `smtp` | `SMTP_HOST` and related variables, via the optional `nodemailer` dependency |

Click tracking is turned off where the provider allows it, because rewritten links break signed Add URLs. `HUNTLEY_MOCK_EMAIL=true` forces `console`. A dry run writes `<date>-dryrun.html` and `.txt` instead of sending.

**Marking seen.** After a successful send, every ranked and every capped job is appended to `seen.tsv`. A failed send throws before this, so tomorrow's run offers the same roles again. A dry run marks nothing.

**Records.** Every run writes `runs/<date>-raw.json` before dedupe and a line in `runs/runs.jsonl`. After ranking, a real run merges its decisions into `runs/<date>-shown.json` by job id, never replacing a mailed entry with an unmailed one; a dry run writes `runs/<date>-shown.dryrun.json` instead, which the weekly review does not read. `--no-scan` replays the raw snapshot instead of collecting.

---

## 5. Tracker integration

### 5.1 Signed links

Add and APPROVE buttons are GET links to a Google Apps Script web app. `actionUrl()` in `src/sheet/links.mjs` builds them:

```
payload   = "<action> <id> <exp> <c> <t> <u> <l> <s>"
            each detail percent-encoded, empty when absent
signature = base64url(HMAC-SHA256(payload, HUNTLEY_LINK_SECRET))
url       = <webapp>/exec?a=<action>&id=<id>&exp=<exp>&sig=<signature>&c=&t=&u=&l=&s=
```

- **Fields.** `action` is `add`, `ignore` or `approve`. `id` is a job id or proposal id. `exp` is a Unix timestamp: Add links expire after 30 days, APPROVE links after 90. The details are company, title, apply URL, location and source; a detail too long for a link is omitted and signed as empty.
- **Signing.** The Apps Script writes the details into the sheet, so they are covered by the signature.
- **Verification.** `verify()` recomputes the signature and compares it in constant time.

### 5.2 The Apps Script endpoint

`apps-script/Code.gs` is deployed as a web app that executes as the sheet's owner and accepts anonymous requests; the signature is what authorises a request. `doGet()`:

1. Rebuilds the payload from the request parameters and rejects the request if the signature does not match or the link has expired.
2. Takes a script lock, so concurrent clicks cannot write two rows.
3. Dispatches on the action:
   - `add` appends to Applications with status `To apply` and to Inbox with status `added`, unless the job id is already in Applications.
   - `ignore` appends to Inbox with status `ignored`.
   - `approve` appends to Approvals, unless the proposal id is already there.
4. Returns a confirmation page.

Every written cell passes through `safeText_()`, which prefixes values starting with `=`, `+`, `-` or `@` so Sheets does not evaluate them as formulas. The confirmation page escapes all text and renders the job link only if it is `http` or `https`.

The sheet has three tabs, created on first use:

| Tab | Columns |
|---|---|
| Applications | `added_at, job_id, company, title, url, location, source, status, applied_at, last_update, outcome, notes` |
| Inbox | `added_at, job_id, company, title, url, status` |
| Approvals | `approved_at, proposal_id, status` |

The signature format is implemented in both `links.mjs` and `Code.gs`. `tests/links.test.mjs` reads `Code.gs` and asserts its payload construction, detail order, encoding and base64url conversion match huntley's.

### 5.3 Read-back and approvals

`syncTracker()` in `src/sheet/sync.mjs` reads the tabs as published CSV:

1. **Fetch.** `HUNTLEY_SHEET_CSV_URL` is the published Inbox tab. Applications and Approvals are fetched by substituting their `gid` from `sheet.gids`, and a tab with no gid is not fetched. A response that is Google's sign-in page, rather than CSV, is treated as a failure. CSV is parsed per RFC 4180, since titles contain commas, quotes and newlines.
2. **Merge.** Each tab that loaded replaces its copy in `tracker.json`. A tab that failed keeps its previous copy, and the sync reports itself as degraded: a warning in the digest, and exit code 1 from `huntley sync`.
3. **Apply.** An approval row is applied only if its proposal id is not in `proposals/applied.jsonl` and its proposal file exists (section 6.3).

Sheet dates are rendered in the spreadsheet's locale, so `sheetDate()` normalises ISO, `YYYY/M/D` and `M/D/YYYY` (or `D/M/YYYY` when the first number cannot be a month) before any comparison.

---

## 6. Weekly review

`runWeekly()` in `src/weekly.mjs` syncs the tracker, gathers evidence, and emails either a proposal or a notice that nothing is proposed.

### 6.1 Evidence

Over `weekly.lookback_days`:

| Evidence | From |
|---|---|
| Shown | Jobs in `runs/*-shown.json` with `inEmail` true; roles below the threshold or past the row limit were never shown |
| Rejected | Rejections in the same records |
| Added | Inbox rows with status `added` and a normalised date inside the window |
| Outcomes | Applications rows with an outcome recorded |

Shown jobs are split into added and ignored by job id. Below `weekly.min_shown` shown or `weekly.min_added` added, nothing is proposed and the notice says why; `--force` overrides this.

### 6.2 Proposals

`buildProposal()` in `src/memory/propose.mjs` runs deterministic detectors first. Each attaches the jobs that triggered it as evidence:

| Detector | Fires when | Proposes |
|---|---|---|
| Watchlist candidate | Several roles added from a company that is not tracked | A note naming the company and the resolver command |
| Unused keyword | A keyword appeared in many shown titles and none were added | Removing the keyword from its group |
| Over-eager exclusion | Added roles whose titles an exclusion would have rejected | Removing the exclusion |

When enough roles were added, the agent CLI is then given the reasons for added and ignored roles and asked for at most a few durable notes, which can only be proposed as `add_note`. If the CLI fails, the detector findings are still proposed.

A proposal is `{id, createdAt, window, summary, changes}`. Each change is one of four operations — `add_list_item`, `remove_list_item`, `add_note`, `set_scalar` — on a path matching the allowlist in `src/memory/apply.mjs`: `targets.role_terms`, `targets.title_keywords` and its groups, `targets.exclude_titles`, `targets.preferred_levels`, `location.allow`, `filters.block_companies`, `filters.block_content`, `filters.exclude_seniority`, `filters.deprioritize`, and `notes`. `validateProposal()` checks this on generation and again on apply. The proposal is saved to `proposals/<id>.json`, then emailed with its evidence and an APPROVE link.

### 6.3 Applying

`applyProposal()` in `src/memory/apply.mjs` is the only code that writes `preferences.yml`. It runs when sync finds an approval, or from `weekly --apply <id>`.

1. **Validate** the proposal.
2. **Back up** the file to `proposals/preferences.before-<id>.yml`.
3. **Apply each change as a text edit.** `findBlock()` locates a key by walking indentation, and each change inserts or deletes one line, so comments are preserved. An inline list is first rewritten as a block list, and removing a list's last item leaves `key: []`. Adding an item already present does nothing; removing one that is absent throws. Values YAML would misread are quoted.
4. **Check the result.** It must parse, and pass the same `targets` and `location` validation every run starts with. Otherwise nothing is written.
5. **Write** the file and append the proposal to `proposals/applied.jsonl`.

---

## 7. Failure handling

| Failure | Behaviour |
|---|---|
| A lane throws | Source listed as failed, warning in the digest, other lanes unaffected |
| A board lane hits its collection deadline | Completed boards are kept; incomplete/aborted boards are reported; other lanes unaffected |
| ATS dataset stale or unreachable | Warning; fallback sweep of Greenhouse, Lever and Ashby |
| A fund page fails | Last cached company list used, warning |
| A board-name lookup fails | Slug name kept; retried on a later run |
| Wellfound fallback page, or LinkedIn/Wellfound block | Page discarded or lane stopped, warning |
| freehire ignores a parameter | Lane fails rather than returning the unfiltered catalogue |
| Ranking CLI missing, or batches fail | Heuristic scores, marked unassessed, warning |
| Sheet tab fails to load | Previous copy kept, warning, `sync` exits 1 |
| Approval cannot be applied | Logged; `preferences.yml` unchanged |
| Email send fails | Run throws and exits non-zero; nothing marked seen |
| No matches | Digest sent anyway, saying so |

---

## 8. Security and privacy

- **Personal data is gitignored:** `config/huntley.yml`, `preferences.yml` and `watchlist.yml`, `.env`, `data/`, and CV files. The repository ships only `*.example.*` files. Nothing checks for a personal file that is force-added or was tracked before it was ignored.
- **Secrets come from the environment.** `.env` stays out of YAML, and config values reference secrets as `${VAR}`.
- **Links are signed.** Add and APPROVE links carry an HMAC over action, target, expiry and the written details, and expire. The endpoint writes only `To apply` and `ignored` rows and approval records; nothing in huntley submits an application.
- **Untrusted text is escaped.** Posting text is third-party input: it is HTML-escaped in digests and on the confirmation page, and guarded against formula injection in the sheet.
- **Private addresses are refused.** Company websites, board pages and fund pages come from third parties, so huntley fetches them through the in-tree HTTP helpers under `src/sources/boards/http/`, which refuse connections to private and link-local addresses.
- **Proposals are confined.** Preference changes are restricted to allowlisted paths and operations, require an approval or an explicit command, and are backed up.
- **Scraped sources respect CI.** LinkedIn and Wellfound are disabled in CI environments.

---

## 9. Operations

### 9.1 doctor

`huntley doctor` checks:
- Node version, dependencies, and registered board providers;
- config validity and the derived title filter;
- the watchlist, fund portfolios and active boards;
- ATS dataset freshness, freehire reachability, and the Built In, LinkedIn and Wellfound request plans;
- whether `preferences.background.summary` is filled, and the ranking CLI;
- email transport credentials and deliverability;
- Add-link configuration and tracker read-back gids;
- whether `preferences.yml` changed without a recorded approval.

It exits non-zero when anything would stop a run.

### 9.2 Logging

All logs go to stderr with timestamps, at `HUNTLEY_LOG_LEVEL` (`--verbose`, `--trace` and `--quiet` set it).

### 9.3 Dry runs and replays

| Command | Collects | Ranks | Sends | Changes state |
|---|---|---|---|---|
| `run --dry-run` | yes, into a temporary collection tree | yes | no, writes preview report under `runs/preview/` | no: checkpoints, role decisions, seen ledger, delivery record, active boards, tracker and preferences untouched; writes its own `-shown.dryrun.json`; caches may be filled |
| `run --no-scan` | no, replays a stored snapshot (latest non-preview, or `--run-id`) | yes | local report always; email if configured | yes for role decisions and local publication, except collection checkpoints and learning boards |
| `weekly --dry-run` | — | proposal built | no | no approvals applied, tracker snapshot unchanged |
| `sync --dry-run` | — | — | — | nothing written or applied |

### 9.4 Scheduling

Scheduling is optional. `huntley run` is the local catch-up workflow. If you want unattended runs, `deploy/` contains a service and a timer for each of `daily` (alias) and `weekly`. The services are one-shot units that run as a `huntley` user from `/opt/huntley`, wait for the network, load `/opt/huntley/.env`, allow writes only to `data/` and `config/`, and retry once after a failure. The timers use `Persistent=true`, so a run missed while the machine was asleep or off happens when it comes back. Logs go to the journal.

---

## 10. Testing

`npm test` runs every `tests/*.test.mjs` with `node --test`, without network access or a real model. Suites that touch state set `HUNTLEY_DATA_DIR` and `HUNTLEY_CONFIG_DIR` to scratch directories before importing, and assert that paths resolved there. Network-backed modules are tested with injected fetchers or a replaced `globalThis.fetch`. The end-to-end suite runs `runHuntley()` over a fixture snapshot with `--no-scan`, with a stub ranking CLI placed first on `PATH`, covering:
- dedupe;
- every rejection reason;
- the seen ledger;
- dry runs;
- zero-match digests;
- applying approvals before ranking.

Contract tests hold external shapes to what huntley emits: board URLs against in-tree providers' `detect()`, and the link signature against `Code.gs`.

`npm run test:live` requests every configured board once and checks that each returns plausible data, without ranking or sending.

---

## 11. Known limitations

- **Indeed and Glassdoor are not read.**
- **Gem, JazzHR, Breezy, Jobvite, Workable, Rippling and SmartRecruiters have no complete company list.** Their companies are reached through freehire, fund portfolios, the watchlist or active boards. Eightfold and Jibe boards are never read directly.
- **The ATS dataset and freehire are third-party services.** The dataset can lag by a day, and only it has a fallback.
- **The per-company cap runs before ranking,** so it chooses by heuristic.
- **Model scores vary between runs.** Judged roles are marked seen, so lowering the threshold does not revisit them.
- **Two distinct ATS requisitions that share a company and title stay separate.** Company+title merge is only used when stronger identity is absent and location/URL evidence is unambiguous.
- **The residential gate recognises CI environments,** not datacenter addresses.
- **A role closed between scan and digest still appears.**
- **Location tables are finite.** A US city given without its state is placed only if it is in the city table.
- **Some funds cannot be read.** Many company sites render careers pages client-side. Benchmark publishes no portfolio, First Round's board requires login, and no site was found for Bluebirds or Juniper.
- **JazzHR listings carry no posting date.**
- **Apps Script updates must be deployed by hand** as a new version of the existing deployment; a new deployment changes the URL, and a signature change invalidates links already sent.
- **Outcomes in the Applications tab are recorded by hand.**