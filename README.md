# huntley

A personal job-search pipeline you run locally whenever you want. Each `huntley run` scans the company-ATS layer and the job-board layer, catches up on anything posted since the last successful collection, collapses them into one deduplicated list, ranks what is left against your background, and writes a complete local report. Email, if you configure it, is a shorter summary.

**Documentation:** [what huntley must do](docs/prd.md) · [how it works](docs/tech-design.md) · [setting it up with an AI agent](AGENTS.md)


## Setup

Prefer to have an agent do this? Open the repo in Claude Code, Cursor, Codex, Gemini CLI or opencode and ask it to set huntley up for you. They all read [AGENTS.md](AGENTS.md) automatically, which tells them to interview you about
what you want out of a job search rather than guessing, and which commands are safe to run unattended. The rest of this section is the same process by hand.

### 0. Requirements

| | |
|---|---|
| **Node** | 20 or newer |
| **git** | |
| **An agent CLI** | optional — `claude`, `gemini`, `codex`, `opencode` or `cursor-agent`. On a Claude Pro plan, `claude -p` draws on your existing subscription rather than metered API billing. Without one, huntley still runs and ranks heuristically. |
| **A Google account** | optional — only for the Add button and the tracker |
| **An email provider** | optional — Resend, Mailjet or any SMTP host. Without one, digests are written to `data/digests/`. |


### 1. Clone and install

```bash
git clone https://github.com/victorjaml/huntley.git
cd huntley
npm install
```

### 2. Generate your config and fill them in

```bash
node bin/huntley.mjs setup --cv /path/to/resume.tex
```

One command: creates the three config files (and a `.env` for secrets) and summarises the resume into `preferences.background.summary`. Omit `--cv` if you will write the summary by hand; run `setup --cv` later to refresh it. You can edit these files anytime between runs to alter the behavior.

| File | What it decides |
|---|---|
| `config/preferences.yml` | What a good role looks like for you — titles, keywords, exclusions, locations, and a short background the ranker scores every posting against |
| `config/watchlist.yml` | Which companies and funds to check every morning through their own job boards. Matching roles from companies you named earn a score bonus. There are some pre-populated funds there to get you started — edit to suit your preferences|
| `config/huntley.yml` | How the pipeline runs — your email, which sources are on, and every tuning lever for ranking, digest size, and the tracker sheet |

Each file's comments are a fill-in guide. The matching `*.example.yml` lists every available lever with its default value — compare against those when tuning.

Ashby/Lever/Greenhouse list responses already include JD text; Huntley stores descriptions on the job records directly for ranking.

For the `watchlist` you can use `discover-board` to help add multiple companies at once

```bash
node bin/huntley.mjs discover-board Anthropic Ramp Figma --summary
```

It probes the public APIs, reports which board each company really uses, and prints `config/watchlist.yml` entries ready to paste. Add `--write` to append them for you.

```
  Company     Vendor      Jobs   Board
  ------------------------------------------------------------------
  Anthropic   greenhouse  595    https://job-boards.greenhouse.io/anthropic
  Ramp        ashby       145    https://jobs.ashbyhq.com/ramp
  Figma       greenhouse  153    https://job-boards.greenhouse.io/figma
```

Companies it cannot resolve are listed for manual follow-up rather than dropped.

### 3. Check the install

```bash
node bin/huntley.mjs doctor
```

Fix anything marked `✗`. Warnings are fine to start with — they describe limitations, not breakage.

### 4. First run, sending nothing

```bash
node bin/huntley.mjs run --dry-run
open data/runs/preview/*/report.html
```

`--dry-run` writes a complete local report and sends nothing. It does **not** change catch-up checkpoints, the role ledger, or `data/seen.tsv`, so you can sanity-check ranking and preferences without locking anything in. Skip the dry-run if you're ready to commit on that first shot. Scheduler and Apps Script are optional.

### 5. Turn on email

Pick a provider in `config/huntley.yml` and put the credential in `.env`:

```yaml
email:
  provider: resend              # console | resend | smtp | mailjet
  from: "huntley@yourdomain.com"
  from_name: "huntley"
  to: "you@example.com"
```

```bash
# .env
RESEND_API_KEY=re_...
```

For SMTP, also `npm install nodemailer` and set `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`.

Then run it for real:

```bash
node bin/huntley.mjs run
```

### 6. Wire up the Add button

Ten minutes, no cost, no server: **[docs/google-sheets-setup.md](docs/google-sheets-setup.md)**.

Until you do, posting titles still link to the employer. There are no Add actions, and that is normal local operation — not a degraded run.

---

## Running it

```bash
node bin/huntley.mjs run                # catch up → rank → complete local report (email if configured)
node bin/huntley.mjs run --dry-run      # preview; writes preview artifacts only
node bin/huntley.mjs run --no-scan      # replay the latest stored snapshot
node bin/huntley.mjs run --since 2026-09-01  # widen the catch-up lower bound
node bin/huntley.mjs daily              # alias for run
node bin/huntley.mjs weekly             # review, email a proposed preference diff
node bin/huntley.mjs weekly --dry-run   # see the proposal without mailing it
node bin/huntley.mjs weekly --force     # propose even when the evidence is thin
node bin/huntley.mjs weekly --apply <id> # apply a stored proposal without clicking APPROVE
node bin/huntley.mjs sync               # pull Add / APPROVE clicks from the sheet (run and weekly do this first)
node bin/huntley.mjs sync --dry-run     # read the sheet, change nothing
node bin/huntley.mjs doctor             # verify the install
node bin/huntley.mjs setup              # (re)create config from the examples
```

Global flags: `--verbose`, `--trace`, `--quiet`, `--help`.

There are npm aliases for the common ones:

```bash
npm run run
npm run huntley -- run --dry-run
npm run weekly
npm run doctor
```

### Useful environment overrides

```bash
HUNTLEY_MOCK_EMAIL=true node bin/huntley.mjs run   # force the console transport
HUNTLEY_LOG_LEVEL=trace  node bin/huntley.mjs run  # every subprocess line
```

---

## Using it

Once setup is done, huntley is a local report you can run any time, plus an optional email and spreadsheet. You do not need a scheduler, Apps Script, or an email account to capture and review roles. How to leave it running unattended is under [Scheduling](#scheduling) — that is optional.

### The morning email

Each run writes a complete report under `data/runs/`. Email, if configured, is a shorter summary capped by `digest.max_rows`. A day with no matches still writes a local summary; a silent inbox only ever means the run failed or email was skipped. Without email configured, console mode writes the digest next to that report.

Each row is one role. The title links to the employer's own posting, not a board redirect. Under it: the company, the location, when it was posted, one sentence on why it fits you, and an assigned score.

What you do with a row is one of two things:

- **Add**, if you want to apply to it. That writes the role to your tracker with status `To apply`. It does not apply. You still open the posting and submit yourself.
- **Nothing**, if you don't. A role you were shown and did not add is the weekly review's signal that it wasn't worth it. There is no reject button.

### The tracker

The **Applications** tab is the only place you live. huntley writes a row when you click Add and does not write to it again. **Inbox** and **Approvals** are logs. Don't edit them.

After you actually apply, update the row. The columns that matter:

| Column | When you fill it |
|---|---|
| `status` | Starts as `To apply`. Change it once you have applied, and again if that changes. |
| `applied_at` | The day you submitted. |
| `outcome` | What happened after — a reply, a rejection, an offer. The weekly review only sees rows where this is filled in. |
| `notes` | Anything you want to remember. Yours; huntley does not read this column as instructions. |

### Once a week

A second email arrives: proposed changes to `config/preferences.yml`, each one shown next to the roles that produced it. Reading it changes nothing. Ignoring it changes nothing. **APPROVE** applies the whole set, and it takes effect on the next run, not in the email.

## Scheduling

Scheduling is optional. `huntley run` is the local workflow; weeks between runs still catch up from each source's last successful collection. If you want unattended runs, systemd timers on a Linux machine are in `deploy/` (a daily alias and a weekly service).

Edit the unit files first: they run as a `huntley` user (create it with `sudo useradd --system huntley` and give it the checkout, or change `User=` to your own account), assume the checkout is at `/opt/huntley`, and read secrets from `/opt/huntley/.env`.

```bash
sudo cp deploy/huntley-*.service deploy/huntley-*.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now huntley-daily.timer huntley-weekly.timer

systemctl list-timers 'huntley-*'      # when each runs next
journalctl -u huntley-daily -n 50      # the last run's log
```

The timers set `Persistent=true`, so a run missed while the machine was asleep or off happens when it comes back. A failed run retries once, ten minutes later.

---

## Testing

Three tiers, fastest first. Run the first two constantly; the third before you push.

```bash
npm test          # everything offline — unit + end-to-end, ~0.2s, no network
npm run test:unit # the unit suites alone
npm run test:e2e  # the full pipeline offline: collect → rank → render → send
npm run test:live # hits every configured board once, ~1 min, no model, no mail
npm run check     # test + test:live
```

`npm test` is hermetic: no network, no model, no writes outside a scratch directory. `test:e2e` exercises the whole of `runDaily()` by replaying a fixture snapshot through `--no-scan` and putting a stub ranker (`tests/fixtures/bin/claude`) on PATH, so a pipeline change is verified in a fraction of a second instead of the several minutes a live run takes. For a network-free `--no-scan` replay outside tests, set `enrichment.enabled: false` — enrichment may otherwise fetch Greenhouse/Lever/Ashby detail pages even when collection is skipped.

`test:live` catches the failure the offline tests structurally cannot: a board that changed its markup or API and now returns nothing while everything still "works". It prints one line per configured board.

```bash
node --test tests/dedupe.test.mjs             # one suite
node --test --test-name-pattern "watchlist"   # by name
```

No framework — `node --test` and `node:assert/strict`. New suites go in `tests/*.test.mjs` and are discovered automatically.

Checking that nothing personal is about to be committed:

```bash
git status --short
for f in config/huntley.yml config/preferences.yml config/watchlist.yml .env; do
  git check-ignore -q "$f" && echo "$f ignored ✓" || echo "$f NOT IGNORED ✗"
done
```

---

## Working on the code

### Adding a job source

Write an adapter in `src/sources/` that returns `{ jobs, units }` and add it as a lane in `collectAll()` in `src/run.mjs`:

```js
import { toJob } from '../normalize.mjs';

export async function searchThing({ queries = [] } = {}) {
  const jobs = [];
  for (const row of await fetchSomehow(queries)) {
    const job = toJob({
      url: row.link, title: row.title, company: row.employer,
      location: row.city, postedAt: row.published,
      source: 'thing', sourceDetail: `thing:${row.board}`,
    });
    if (job) jobs.push(job);          // toJob returns null for unusable rows
  }
  return jobs;
}
```

Then push a lane — `lanes.push({ name: 'thing', run: () => searchThing(s.thing) })` — and add a `sources.thing` section to `config/huntley.example.yml`. Lanes run in parallel; throwing from inside one degrades the run rather than failing it. If a job's URL names an ATS board, huntley starts reading that board directly once one of its roles scores above the threshold — nothing else to wire up.

### Adding an ATS vendor

If the vendor has a public API, add a provider under `src/sources/boards/providers/` with `{ id, detect?, fetch }`, register it in `src/sources/boards/registry.mjs`, and add a fixture test. Use `jazzhr.mjs` as the template.

### Changing the Apps Script

After editing `apps-script/Code.gs`, paste it into the Apps Script editor and redeploy:

**Deploy › Manage deployments › ✏️ › Version: New version › Deploy**

Creating a *new deployment* instead issues a new URL and silently breaks every Add link in every digest you have already been sent.

If you change how the signature is built, change it in **both** `apps-script/Code.gs` and `src/sheet/links.mjs`, and update `tests/links.test.mjs`, which pins the two together. A signature change invalidates every unexpired link in digests already sent.

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| `cannot derive API URL for <Company>` | the `careers_url` in `watchlist.yml` is a marketing page — resolve it with `huntley discover-board` |
| `no agent CLI found` | install one, or set `rank.cli` to one you have. huntley still runs and ranks heuristically. |
| Digest arrives with no Add buttons | `sheet.enabled` is false, or `HUNTLEY_LINK_SECRET` is unset — see [google-sheets-setup.md](docs/google-sheets-setup.md) |
| "This link's signature is not valid" | `HUNTLEY_LINK_SECRET` differs between `.env` and the Apps Script's Script Properties |
| `huntley sync` returns a sign-in page | `HUNTLEY_SHEET_CSV_URL` is the normal sheet URL, not the published-CSV one |
| Weekly says "not enough evidence" | working as intended — it needs ~40 roles shown and ~8 added. `--force` to see what it would say. |
| Digest re-sent the same roles | `data/seen.tsv` was cleared or lost |
| No digest at all | Check `data/runs/<id>/report.html`. If you scheduled it, `journalctl -u huntley-daily -n 50`. Silence from email only ever means the run failed or email was skipped. |

### Starting over

Deleting or moving `data/` starts a new catch-up history. Rollback to older binaries cannot safely consume `progress.json` / `roles.json`. To wipe everything, including run history the weekly review learns from and the boards huntley has learned to read:

```bash
rm -rf data/
node bin/huntley.mjs setup
```

Your config and tracker sheet are untouched either way.

---

## Your data

Everything personal is gitignored: `config/*.yml`, `.env`, and all of `data/`. The repository ships only `*.example.*` files, so anyone can clone it and run their own search with no trace of anyone else's.

`data/` holds your run history, seen ledger, rendered digests, proposals and preference backups. Back it up if you care about it; delete it to start fresh.

---

## Built on

- **[career-ops](https://github.com/career-ops-hq/career-ops)** (MIT) — board providers and HTTP infrastructure adapted in-tree under `src/sources/boards/`.
- **[job-board-aggregator](https://github.com/Feashliaa/job-board-aggregator)** (MIT) — the daily dataset of every open Greenhouse, Lever, Ashby, Workday, BambooHR and Paylocity role.
- **[freehire](https://freehire.me)** ([source](https://github.com/strelov1/freehire)) — the public API behind the freehire lanes.
- **[yc-oss](https://github.com/yc-oss/api)** — Y Combinator's company directory as one file.
- **[ai-job-search](https://github.com/MadsLorentzen/ai-job-search)** (MIT) — the `linkedin-search` and `freehire-search` skills, ported to plain Node.

## License

MIT. See [LICENSE](LICENSE). Copyright notices for code adapted from career-ops and ai-job-search are in [NOTICE](NOTICE).
