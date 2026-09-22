// `huntley doctor` — check everything that can silently break a 6:30am cron run.
//
// The failure mode this exists to prevent: a run that looks fine in the log,
// mails nothing, and is not noticed for a week. Every check below corresponds
// to something that has a plausible way of failing quietly.

import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { PATHS } from './lib/paths.mjs';
import { log } from './lib/log.mjs';
import { detectCli, CLI_CANDIDATES } from './rank/llm.mjs';

const OK = 'ok', WARN = 'warn', FAIL = 'fail';
const results = [];
const check = (status, name, detail) => results.push({ status, name, detail });

export async function runDoctor() {
  // ── Runtime ───────────────────────────────────────────────────────
  const major = Number(process.versions.node.split('.')[0]);
  check(major >= 20 ? OK : FAIL, 'node', `v${process.versions.node}${major >= 20 ? '' : ' — huntley needs v20 or newer'}`);

  // ── Board providers (in-tree) ─────────────────────────────────────
  try {
    const { registeredProviderIds } = await import('./sources/boards/registry.mjs');
    const ids = registeredProviderIds();
    const required = ['greenhouse', 'lever', 'ashby', 'workday', 'icims', 'getro', 'consider', 'builtin', 'hackernews', 'jazzhr'];
    const missing = required.filter((id) => !ids.includes(id));
    if (missing.length) check(FAIL, 'board providers', `missing: ${missing.join(', ')}`);
    else check(OK, 'board providers', `${ids.length} registered (${required.length} core)`);
    const lever = await import('./sources/boards/providers/lever.mjs');
    if (typeof lever.formatLeverDescription !== 'function') {
      check(FAIL, 'lever descriptions', 'formatLeverDescription missing');
    } else {
      check(OK, 'lever descriptions', 'descriptionPlain + lists');
    }
  } catch (err) {
    check(FAIL, 'board providers', err.message);
  }

  // js-yaml must resolve for watchlist / config YAML.
  try {
    await import('js-yaml');
    check(OK, 'dependencies', 'js-yaml resolves');
  } catch {
    check(FAIL, 'dependencies', 'js-yaml is missing — run: npm install');
  }

  // ── Config ────────────────────────────────────────────────────────
  let config = null;
  try {
    const { loadConfig } = await import('./config.mjs');
    config = loadConfig();
    check(OK, 'config', 'huntley.yml and preferences.yml load and validate');
  } catch (err) {
    check(FAIL, 'config', err.message.split('\n').slice(0, 4).join(' '));
  }

  if (!existsSync(PATHS.watchlist)) {
    check(WARN, 'watchlist', 'config/watchlist.yml does not exist — the watchlist layer will find nothing');
  } else {
    const { loadWatchlist } = await import('./sources/watchlist.mjs');
    const doc = loadWatchlist();
    const on = (list) => (list ?? []).filter((c) => c && c.enabled !== false).length;
    const companies = on(doc.tracked_companies), boards = on(doc.portfolio_boards);
    check(companies + boards > 0 ? OK : WARN, 'watchlist',
      `${companies} companies, ${boards} VC portfolio boards — all checked every run`);
    const funds = (doc.fund_portfolios ?? []).filter((f) => f?.enabled !== false);
    if (funds.length) {
      const { fundProblem } = await import('./sources/funds/adapters.mjs');
      const problems = funds.map((f) => [f?.name ?? '?', fundProblem(f)]).filter(([, p]) => p);
      let resolved = '';
      try {
        const cache = JSON.parse(readFileSync(join(PATHS.funds, 'resolved.json'), 'utf8'));
        const sites = Object.values(cache.sites ?? {});
        resolved = ` — ${sites.filter((x) => x.status === 'found').length} of ${sites.length} company websites resolved to a job board so far`;
      } catch { resolved = ' — not resolved yet (the first runs resolve them)'; }
      check(problems.length ? FAIL : OK, 'fund portfolios',
        problems.length
          ? problems.map(([n, p]) => `"${n}" ${p}`).join('; ')
          : `${funds.length} funds (${funds.map((f) => f.name).join(', ')})${resolved}`);
    }

    // The ATS dataset is someone else's daily build; if it stops, say so here
    // rather than in a digest that has quietly lost its widest layer.
    if (config?.sources?.ats_dataset?.enabled) {
      try {
        const { DATASET_BASE, datasetAgeHours } = await import('./sources/ats-dataset.mjs');
        const res = await fetch(`${DATASET_BASE}/jobs_manifest.json`, { signal: AbortSignal.timeout(15_000) });
        const manifest = await res.json();
        const age = datasetAgeHours(manifest);
        const max = config.sources.ats_dataset.max_age_hours ?? 48;
        check(age <= max ? OK : WARN, 'ATS dataset',
          `${manifest.chunks?.length ?? 0} files, rebuilt ${Math.round(age)}h ago${age > max ? ` — stale; runs will sweep ${(config.sources.ats_dataset.fallback_sweep ?? []).join(', ')} directly` : ''}`);
      } catch (err) {
        check(WARN, 'ATS dataset', `could not be reached (${err.message}); runs will fall back to sweeping directly`);
      }
      try {
        const ledger = JSON.parse(readFileSync(PATHS.activeBoards, 'utf8'));
        check(OK, 'active boards', `${Object.keys(ledger).length} boards learned so far`);
      } catch { /* none yet: the first run learns them */ }
    }

    const stale = (doc.tracked_companies ?? []).filter((c) => c && 'tier' in c).map((c) => c.name);
    if (stale.length) {
      check(WARN, 'watchlist tiers', `"tier" is no longer used (${stale.slice(0, 3).join(', ')}${stale.length > 3 ? '…' : ''}) — move VC boards under portfolio_boards and delete the key`);
    }

    // Early title filter must derive from preferences (superset of prefilter).
    if (config) {
      try {
        const { scannerTitleTerms } = await import('./sources/watchlist.mjs');
        const terms = scannerTitleTerms(config.preferences?.targets ?? {});
        check(OK, 'title filter',
          `${terms.positive.length} role / ${terms.negative.length} exclusion terms for early collection`);
      } catch (err) {
        check(FAIL, 'title filter', `cannot derive title terms from preferences.yml: ${err.message}`);
      }
    }
  }

  // ── Background the ranker scores against ──────────────────────────
  if (config) {
    const summary = String(config.preferences?.background?.summary ?? '').trim();
    const placeholder = /describe yourself|example|two or three sentences/i.test(summary);
    if (!summary || placeholder) {
      check(WARN, 'background', 'preferences.background.summary is empty or still the example — run: huntley setup --cv /path/to/resume.tex');
    } else {
      check(OK, 'background', `${summary.length} characters in preferences.background.summary`);
    }
    if (config.cv?.path) {
      check(WARN, 'cv.path', 'ignored — ranking reads only preferences.yml; use `huntley setup --cv` to refresh the summary');
    }
  }

  // ── The ranking CLI ───────────────────────────────────────────────
  const cli = await detectCli(config?.rank?.cli);
  if (!cli) {
    check(WARN, 'ranking CLI', `none of ${CLI_CANDIDATES.map((c) => c.bin).join(', ')} found — digests will be ranked heuristically`);
  } else {
    const wanted = config?.rank?.cli;
    check(cli.bin === wanted || !wanted ? OK : WARN, 'ranking CLI',
      cli.bin === wanted || !wanted ? `${cli.bin} found` : `configured as "${wanted}" but only ${cli.bin} is installed — ${cli.bin} will be used`);
  }

  // ── LinkedIn lane ─────────────────────────────────────────────────
  if (config?.sources?.linkedin?.enabled) {
    const li = config.sources.linkedin;
    const planned = (li.queries?.length ?? 0) * (li.locations?.length ?? 0) * (li.max_pages ?? 1);
    const limit = li.request_limit ?? 30;
    check(planned <= limit ? OK : WARN, 'linkedin volume',
      `${planned} request(s) per run${planned > limit ? ` — above request_limit ${limit}, so ${planned - limit} will not be sent` : ''}`);
  }

  // ── freehire feed ─────────────────────────────────────────────────
  if (config?.sources?.freehire_feed?.enabled) {
    try {
      const f = config.sources.freehire_feed;
      const q = new URLSearchParams({ open_within_days: String(f.open_within_days ?? 2) });
      for (const c of f.countries ?? ['us']) q.append('countries', c);
      const res = await fetch(`https://freehire.me/api/v1/jobs/facets?${q}`, { signal: AbortSignal.timeout(20_000), headers: { 'user-agent': 'victorjaml/huntley (+https://github.com/victorjaml/huntley)' } });
      const body = await res.json();
      check(OK, 'freehire feed', `${body?.data?.total ?? '?'} roles first recorded in the last ${f.open_within_days ?? 2}d (about ${Math.ceil((body?.data?.total ?? 0) / 100)} requests before exclusions)`);
    } catch (err) {
      check(WARN, 'freehire feed', `could not be reached (${err.message})`);
    }
  }
  if (config?.sources?.builtin?.enabled) {
    const b = config.sources.builtin;
    check((b.markets ?? []).length ? OK : WARN, 'built in', `${(b.markets ?? []).length} city sites × ${(b.categories ?? []).length} categories, up to ${b.max_pages ?? 4} pages each`);
  }

  // ── Wellfound lane ────────────────────────────────────────────────
  if (config?.sources?.wellfound?.enabled) {
    const wf = config.sources.wellfound;
    const combos = (wf.roles?.length ?? 0) * (wf.locations?.length ?? 0);
    const planned = combos * (wf.max_pages ?? 1);
    const limit = wf.request_limit ?? 100;
    check(combos && planned <= limit ? OK : WARN, 'wellfound lane',
      !combos ? 'no roles or locations configured'
        : `${combos} role × location pages, up to ${planned} request(s) per run, about ${Math.ceil(planned * ((wf.delay_ms ?? 6000) + 600) / 60000)} min`
          + (planned > limit ? ` — above request_limit ${limit}, so part of the plan rotates across days` : ''));
  }

  // ── Email ─────────────────────────────────────────────────────────
  if (config) {
    const provider = config.email?.provider;
    const need = { resend: ['RESEND_API_KEY'], mailjet: ['MAILJET_API_KEY', 'MAILJET_API_SECRET'], smtp: ['SMTP_HOST'] }[provider] ?? [];
    const missing = need.filter((k) => !process.env[k]);
    if (provider === 'console') {
      check(WARN, 'email', 'provider is "console" — digests are written to data/digests/ and never sent');
    } else if (missing.length) {
      check(FAIL, 'email', `provider "${provider}" is missing ${missing.join(', ')} in .env`);
    } else {
      check(OK, 'email', `${provider} → ${config.email.to ?? config.identity.email}`);
    }
    if (provider === 'smtp') {
      try { await import('nodemailer'); check(OK, 'nodemailer', 'installed'); }
      catch { check(FAIL, 'nodemailer', 'required for the smtp provider — run: npm install nodemailer'); }
    }
    if (provider !== 'console' && config.email?.from === config.email?.to) {
      check(WARN, 'email deliverability', 'from and to are the same address — providers often flag self-addressed mail as spam');
    }
  }

  // ── Add links ─────────────────────────────────────────────────────
  if (config?.sheet?.enabled) {
    if (!process.env.HUNTLEY_LINK_SECRET) check(FAIL, 'Add links', 'HUNTLEY_LINK_SECRET is not set — links cannot be signed');
    else if (!config.sheet.webapp_url) check(FAIL, 'Add links', 'sheet.webapp_url is empty — no endpoint to link to');
    else if (!/^https:\/\/script\.google\.com\/.*\/exec$/.test(config.sheet.webapp_url)) {
      check(WARN, 'Add links', 'sheet.webapp_url does not look like an Apps Script /exec URL');
    } else check(OK, 'Add links', 'endpoint and signing key are configured');
  } else {
    check(WARN, 'Add links', 'sheet.enabled is false — digests will have no Add buttons (see docs/google-sheets-setup.md)');
  }

  // ── Tracker read-back ─────────────────────────────────────────────
  if (process.env.HUNTLEY_SHEET_CSV_URL?.trim()) {
    const gids = config?.sheet?.gids ?? {};
    const missing = ['approvals', 'applications'].filter((t) => gids[t] == null || gids[t] === '');
    check(missing.includes('approvals') ? WARN : OK, 'tracker read-back',
      missing.length
        ? `no sheet.gids for ${missing.join(' and ')} — ${missing.includes('approvals') ? 'APPROVE clicks will not be applied' : 'outcomes you record by hand will not be read'} (docs/google-sheets-setup.md, step 7)`
        : 'inbox, applications and approvals tabs are configured');
  }

  // ── Preference-memory integrity ───────────────────────────────────
  // The promise is that preferences.yml only ever changes by your hand or by an
  // approved proposal. If it changed since the last recorded approval and there
  // is no approval to account for it, say so rather than let it pass.
  checkPreferenceIntegrity();

  // ── Writable state ────────────────────────────────────────────────
  try {
    statSync(PATHS.data);
    check(OK, 'data directory', `${PATHS.data.replace(PATHS.root + '/', '')} (gitignored)`);
  } catch {
    check(FAIL, 'data directory', 'missing — run: huntley setup');
  }

  // ── Units that have failed every recent run ───────────────────────
  // Per-board errors used to live only in the run manifest, so a board that
  // failed every morning looked fine in the log. progress.json only keeps the
  // last status; the last three manifests are the consecutive record.
  try {
    const { listRunDirs } = await import('./state/catchup.mjs');
    const { unitsFailedAcrossRuns, collectionUnitLists } = await import('./state/coverage.mjs');
    const manifests = listRunDirs()
      .filter((r) => existsSync(join(r.path, 'manifest.json')))
      .map((r) => {
        try { return JSON.parse(readFileSync(join(r.path, 'manifest.json'), 'utf8')); } catch { return null; }
      });
    const lists = collectionUnitLists(manifests, { consecutive: 3 });
    if (lists.length >= 3) {
      const stuck = unitsFailedAcrossRuns(lists, { consecutive: 3 });
      if (stuck.length) {
        check(WARN, 'repeated coverage failures',
          `${stuck.length} unit(s) failed in each of the last 3 runs: ${stuck.slice(0, 5).join(', ')}${stuck.length > 5 ? '…' : ''}`);
      } else {
        check(OK, 'repeated coverage failures', 'no unit failed in each of the last 3 runs');
      }
    }
  } catch { /* no run history yet */ }

  return report();
}

function checkPreferenceIntegrity() {
  if (!existsSync(PATHS.preferences)) return;
  const ledger = join(PATHS.proposals, 'applied.jsonl');
  if (!existsSync(ledger)) {
    check(OK, 'preference memory', 'no proposals have ever been applied — every line in it is yours');
    return;
  }
  const applied = readFileSync(ledger, 'utf8').trim().split('\n').filter(Boolean).length;
  check(OK, 'preference memory', `${applied} approved proposal(s) applied to date; see data/proposals/`);
}

function report() {
  // log.* already supplies the status glyph, so the row carries only the
  // aligned name and detail.
  const width = Math.max(...results.map((r) => r.name.length));

  process.stderr.write('\n');
  for (const r of results) {
    const line = `${r.name.padEnd(width)}  ${r.detail}`;
    if (r.status === FAIL) log.error(line);
    else if (r.status === WARN) log.warn(line);
    else log.ok(line);
  }

  const fails = results.filter((r) => r.status === FAIL).length;
  const warns = results.filter((r) => r.status === WARN).length;
  process.stderr.write('\n');

  if (fails) {
    log.error(`${fails} problem(s) will stop a run${warns ? `, plus ${warns} warning(s)` : ''}.`);
    return 1;
  }
  if (warns) {
    log.warn(`${warns} warning(s) — huntley will run, with the limitations listed above.`);
    return 0;
  }
  log.ok('Everything checks out.');
  return 0;
}
