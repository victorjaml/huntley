# Working on huntley as an agent

You are helping one person set up and run their own job search. Read this before touching anything. The [README](README.md) explains what huntley does and how a human uses it; this file is the set of rules you follow.

---

## 1. Ask. Never invent.

huntley ranks every posting against one person's career. If you guess at that, it produces a confident, plausible, and completely wrong job search — and it will pass `doctor`, because `doctor` only checks that `background.summary` is no longer the placeholder.

**Interview the user before you write any of these. Do not infer them from the repo, from their git config, or from a resume you have not been given.**

| File | Fields that are theirs to answer |
|---|---|
| `config/preferences.yml` | `targets.role_terms`, `targets.title_keywords`, `targets.exclude_titles`, `background.summary`, `background.strengths`, `background.domains`, `location.base`, `location.allow`, `location.remote`, `compensation.*`, `filters.block_companies` |
| `config/watchlist.yml` | `tracked_companies` — which employers they actually care about |
| `config/huntley.yml` | `identity.name`, `identity.email`, `identity.timezone`, `email.*` |

Good questions to ask: What titles do you want? What do you never want to see? Where will you physically work, and is remote acceptable? Which companies are on your list already? What have you been doing, and what do you want next?

Every one of these files has fill-in comments, and the matching `*.example.yml` lists every available lever with its default. Read the comments before editing — the matching rules (whole-word, `*` suffix, `@group` references) are documented there and are easy to get subtly wrong.

`config/preferences.yml` is ground truth and the user's to edit. The weekly loop only ever *proposes* changes to it. Do not rewrite it wholesale to "clean it up."

---

## 2. Command safety

| Command | Effect |
|---|---|
| `huntley setup` | Safe. Idempotent — never overwrites a file that exists. |
| `huntley doctor` | Safe. Read-only. |
| `huntley run --dry-run` | Safe. Writes `data/runs/preview/<id>/`, sends nothing, advances no checkpoint. |
| `huntley discover-board X` | Safe — network reads. `--write` appends to `config/watchlist.yml`. |
| `huntley sync --dry-run` | Safe. Reads the sheet, changes nothing. |
| `npm test`, `test:unit`, `test:e2e` | Safe. Hermetic — no network, no writes outside a scratch dir. |
| `npm run test:live` | Network. Hits every configured board once (~1 min). Don't loop it. |
| `huntley run` | **Mutates.** Advances catch-up checkpoints, the role ledger and `data/seen.tsv` — irreversibly. **Sends email if configured.** |
| `huntley weekly` | **Sends email.** |
| `huntley sync` | Writes Add/APPROVE clicks back into local state. |
| `rm -rf data/` | **Destroys** run history, the seen ledger, and the evidence the weekly review learns from. |

Default to `--dry-run`. Run a real `run` or `weekly` only when the user has asked for that specific thing, and say what it will do first.

Deleting `data/` is the user's call, never yours — including when a run looks broken. Almost nothing is fixed by starting the history over.

---

## 3. Never commit the user's life

Already handled by `.gitignore`, and it must stay that way:

    .env                  secrets and the link-signing key
    config/*.yml          their preferences, employers, email address
    data/                 run history, digests, seen ledger, resume, tracker

The repo ships only `*.example.*` counterparts. Before any commit:

```bash
git status --short
for f in config/huntley.yml config/preferences.yml config/watchlist.yml .env; do
  git check-ignore -q "$f" && echo "$f ignored ✓" || echo "$f NOT IGNORED ✗"
done
```

Never `git add -A` without reading what it staged. Never weaken `.gitignore`. Never paste the contents of `.env`, `config/*.yml` or anything under `data/` into a commit message, an issue, a PR, or a message to a third-party service.

---

## 4. The path

```bash
npm install
node bin/huntley.mjs setup          # creates config/*.yml + .env from examples
                                    # → then INTERVIEW THE USER (§1)
                                    # → then edit the three config files
node bin/huntley.mjs doctor         # fix every ✗
node bin/huntley.mjs run --dry-run
open data/runs/preview/*/report.html
```

Email, the Google Sheet tracker, and scheduling are all optional and all come later. A dry run with `email.provider: console` and `sheet.enabled: false` is a complete, correct install — not a degraded one. Don't push the user toward configuring Resend or Apps Script to "finish" setup.

`huntley setup --cv <path>` summarises a resume into `preferences.background.summary`. Two things to know: the resume path is the user's to supply — never go looking for one — and this shells out to an agent CLI (`claude`, `gemini`, `codex`, `opencode` or `cursor-agent`) as a subprocess. If you *are* that CLI, it still works; you are just spawning a fresh one-shot instance, not recursing.

---

## 5. `doctor` is the source of truth

Run it after any config change. Read its output literally:

- `✗` — blocks a run. Fix it. Each line names its own remedy.
- `!` — a limitation, not breakage. Three warnings on a fresh install is normal and expected (empty background, console email, no Add buttons).
- `✓` — done.

When a run misbehaves, read `data/runs/<id>/report.html` and the `doctor` output before changing code. The [troubleshooting table](README.md#troubleshooting) covers the failures that actually happen.

---

## 6. Changing the code

- Tests: `node --test`, `node:assert/strict`, no framework. New suites go in `tests/*.test.mjs` and are discovered automatically. Run `npm test` before you hand anything back — it takes about a second.
- Adding a job source or an ATS vendor: see [Working on the code](README.md#working-on-the-code) in the README.
- `apps-script/Code.gs` and `src/sheet/links.mjs` build the same signature. Change one, change both, and update `tests/links.test.mjs`, which pins them together. A signature change invalidates every unexpired Add link in every digest already sent.
- Redeploying the Apps Script: **Manage deployments › ✏️ › New version**. Creating a *new deployment* issues a new URL and silently breaks every Add link already in the user's inbox.
