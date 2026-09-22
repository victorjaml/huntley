// `huntley sync` — read the tracker sheet back.
//
// The write path is push (a signed link → Apps Script → a row in your sheet).
// This is the read path, and it is pull: huntley fetches the sheet, learns what
// you added, ignored, and how applications went, and applies any APPROVE you
// clicked. Nothing listens on your network in either direction.
//
// Two ways to read, in order of preference:
//
//   1. HUNTLEY_SHEET_CSV_URL — File › Share › Publish to web › a tab as CSV.
//      No credentials, no key on disk, works from anywhere. Note that a
//      published sheet is readable by anyone with the (unguessable) URL, so
//      publish only the Inbox and Approvals tabs if that bothers you.
//
//   2. GOOGLE_SERVICE_ACCOUNT_JSON — a service account with read access to the
//      sheet. Private, but it is a key on disk you have to manage.
//
// Sync runs automatically at the start of the daily and weekly runs, so you
// rarely call it directly; `huntley sync` exists for checking the wiring.
//
// A tab that cannot be fetched keeps its last good copy: the snapshot is the
// only record of what you added once rows scroll off, so an outage must degrade
// the sync, never erase it.

import { readFileSync, writeFileSync, existsSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { PATHS, ensureDirs } from '../lib/paths.mjs';
import { log } from '../lib/log.mjs';

/**
 * Parse RFC 4180 CSV. Sheets quotes any cell containing a comma, quote or
 * newline, and job titles contain all three, so a split(',') would corrupt
 * exactly the rows that matter.
 */
export function parseCsv(text) {
  const rows = [];
  let row = [], field = '', inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += ch;
      continue;
    }
    if (ch === '"') { inQuotes = true; continue; }
    if (ch === ',') { row.push(field); field = ''; continue; }
    if (ch === '\r') continue;
    if (ch === '\n') { row.push(field); rows.push(row); row = []; field = ''; continue; }
    field += ch;
  }
  if (field || row.length) { row.push(field); rows.push(row); }

  if (!rows.length) return [];
  const headers = rows[0].map((h) => h.trim().toLowerCase().replace(/\s+/g, '_'));
  return rows.slice(1)
    .filter((r) => r.some((c) => c.trim()))
    .map((r) => Object.fromEntries(headers.map((h, i) => [h, (r[i] ?? '').trim()])));
}

/**
 * A sheet date as YYYY-MM-DD, or null when it is not one.
 *
 * Apps Script writes real dates, and a published CSV renders them in the
 * spreadsheet's locale — "9/14/2026 10:32:05", not ISO — so comparing the raw
 * strings to an ISO cutoff puts September after October. Month-first is assumed
 * for slashed dates, as Sheets does for a US locale, unless the first number
 * cannot be a month.
 */
export function sheetDate(value) {
  const s = String(value ?? '').trim();
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = s.match(/^(\d{4})\/(\d{1,2})\/(\d{1,2})\b/);
  if (m) return iso(+m[1], +m[2], +m[3]);
  m = s.match(/^(\d{1,2})[/.](\d{1,2})[/.](\d{4})\b/);
  if (m) {
    const [a, b, year] = [+m[1], +m[2], +m[3]];
    return a > 12 ? iso(year, b, a) : iso(year, a, b);
  }
  const t = Date.parse(s);
  return Number.isFinite(t) ? new Date(t).toISOString().slice(0, 10) : null;
}

function iso(year, month, day) {
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/** Swap the `gid` on a published-CSV URL so one URL can reach several tabs. */
function csvUrlForGid(baseUrl, gid) {
  if (!gid) return baseUrl;
  const u = new URL(baseUrl);
  u.searchParams.set('gid', String(gid));
  return u.toString();
}

async function fetchCsv(url) {
  const res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`sheet fetch failed: HTTP ${res.status}`);
  const body = await res.text();
  // A sheet that is not actually published returns Google's sign-in HTML with
  // a 200, which would otherwise parse as one nonsense row.
  if (/^\s*<(!doctype|html)/i.test(body)) {
    throw new Error('the sheet URL returned a sign-in page — publish the tab to the web (File › Share › Publish to web › CSV)');
  }
  return parseCsv(body);
}

const TABS = ['applications', 'inbox', 'approvals'];

/**
 * Pull every tab huntley reads. A tab that fails is listed in `failed` and its
 * rows are left out — never returned as an empty list that looks like a sheet
 * with no rows.
 *
 * HUNTLEY_SHEET_CSV_URL is the published Inbox tab (docs/google-sheets-setup.md). The
 * other tabs are reachable only through their `sheet.gids`: without one, the
 * same URL would return the Inbox again, and its rows would be read as
 * applications and approvals. A tab with no gid is listed in `unconfigured`
 * and not fetched.
 *
 * @returns {Promise<{applications?: object[], inbox?: object[], approvals?: object[], failed: {tab: string, error: string}[], unconfigured: string[]}|null>}
 */
export async function readSheet(config) {
  const csvUrl = process.env.HUNTLEY_SHEET_CSV_URL?.trim();
  if (!csvUrl) {
    log.debug('sheet read-back is not configured (HUNTLEY_SHEET_CSV_URL unset)');
    return null;
  }

  const gids = config?.sheet?.gids ?? {};
  const out = { failed: [], unconfigured: [] };
  for (const tab of TABS) {
    if (tab !== 'inbox' && (gids[tab] == null || gids[tab] === '')) {
      out.unconfigured.push(tab);
      continue;
    }
    try {
      out[tab] = await fetchCsv(csvUrlForGid(csvUrl, gids[tab]));
      log.debug(`  sheet ${tab}: ${out[tab].length} row(s)`);
    } catch (err) {
      out.failed.push({ tab, error: err.message });
    }
  }
  return out;
}

/**
 * Refresh the local tracker snapshot and apply approvals.
 *
 * @param {object} config
 * @param {{dryRun?: boolean}} [opts]  a dry run reads the sheet but writes nothing and applies nothing
 * @returns {Promise<{configured: boolean, applied: number, pending: number, degraded: string|null}>}
 */
export async function syncTracker(config, { dryRun = false } = {}) {
  ensureDirs();
  const sheet = await readSheet(config);
  if (!sheet) return { configured: false, applied: 0, pending: 0, degraded: null };

  const previous = loadTrackerSnapshot();
  const merged = { fetchedAt: new Date().toISOString(), tabFetchedAt: { ...(previous.tabFetchedAt ?? {}) } };
  for (const tab of TABS) {
    if (sheet[tab]) {
      merged[tab] = sheet[tab];
      merged.tabFetchedAt[tab] = merged.fetchedAt;
    } else {
      merged[tab] = previous[tab] ?? [];
    }
  }

  const failures = sheet.failed;
  for (const { tab, error } of failures) log.debug(`  sheet ${tab}: ${error}`);
  if (sheet.unconfigured.length) log.debug(`  sheet ${sheet.unconfigured.join(', ')}: no gid in sheet.gids, not read`);
  const degraded = failures.length
    ? `tracker sync incomplete — could not read ${failures.map((f) => `${f.tab} (${f.error})`).join(', ')}; kept the last good copy`
    : null;
  if (degraded) log.warn(degraded);

  const added = merged.inbox.filter((r) => r.status === 'added');
  const ignored = merged.inbox.filter((r) => r.status === 'ignored');
  log.ok(`tracker: ${merged.applications.length} application(s), ${added.length} added, ${ignored.length} explicitly ignored`);

  if (dryRun) {
    const pending = pendingApprovals(merged.approvals).length;
    if (pending) log.info(`dry run: ${pending} approved proposal(s) not applied`);
    return { configured: true, applied: 0, pending, degraded };
  }

  writeFileSync(join(PATHS.data, 'tracker.json'), JSON.stringify(merged, null, 2));
  const applied = await applyApprovals(merged.approvals, config);
  if (applied) log.ok(`applied ${applied} approved proposal(s) to preference memory`);
  return { configured: true, applied, pending: 0, degraded };
}

/**
 * Mirror the sheet into local state so the weekly review and the daily run can
 * read it without a network call, and so a sheet outage does not erase history.
 */
export async function runSync(config, opts = {}) {
  const res = await syncTracker(config, { dryRun: opts.dryRun });
  if (!res.configured) {
    log.warn('nothing to sync — set HUNTLEY_SHEET_CSV_URL in .env (see docs/google-sheets-setup.md)');
    return 0;
  }
  return res.degraded ? 1 : 0;
}

/**
 * Apply any proposal you approved since the last run.
 *
 * This is the only code path in huntley that writes config/preferences.yml, and
 * it writes only a diff you clicked APPROVE on. An approval row for a proposal
 * huntley has no record of is refused, not guessed at.
 */
function pendingApprovals(approvalRows = []) {
  const ledgerPath = join(PATHS.proposals, 'applied.jsonl');
  const alreadyApplied = new Set(
    existsSync(ledgerPath)
      ? readFileSync(ledgerPath, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l).proposalId)
      : []
  );
  return approvalRows.filter((r) => r.status === 'approved' && !alreadyApplied.has(r.proposal_id));
}

export async function applyApprovals(approvalRows = [], config) {
  const ledgerPath = join(PATHS.proposals, 'applied.jsonl');
  const pending = pendingApprovals(approvalRows);
  if (!pending.length) return 0;

  const { applyProposal } = await import('../memory/apply.mjs');
  let applied = 0;

  for (const row of pending) {
    const proposalPath = join(PATHS.proposals, `${row.proposal_id}.json`);
    if (!existsSync(proposalPath)) {
      log.warn(`approval for "${row.proposal_id}" has no matching proposal on disk — refusing to guess what it meant`);
      continue;
    }
    const proposal = JSON.parse(readFileSync(proposalPath, 'utf8'));
    try {
      applyProposal(proposal);
      appendFileSync(ledgerPath, JSON.stringify({
        proposalId: row.proposal_id,
        approvedAt: row.approved_at,
        appliedAt: new Date().toISOString(),
        changes: proposal.changes.length,
      }) + '\n');
      log.ok(`applied proposal ${row.proposal_id} (${proposal.changes.length} change(s))`);
      applied++;
    } catch (err) {
      log.error(`could not apply proposal ${row.proposal_id}: ${err.message}`);
    }
  }
  return applied;
}

/** Local mirror of the tracker, for readers that must not hit the network. */
export function loadTrackerSnapshot() {
  const p = join(PATHS.data, 'tracker.json');
  return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : { applications: [], inbox: [], approvals: [] };
}
