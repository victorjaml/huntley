// Watchlist loading and title-term derivation (formerly portals-gen helpers).
// Collection no longer writes generated portals YAML.

import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import * as yaml from 'js-yaml';
import { PATHS } from '../lib/paths.mjs';

/** Read config/watchlist.yml. */
export function loadWatchlist() {
  if (!existsSync(PATHS.watchlist)) return { tracked_companies: [], portfolio_boards: [], fund_portfolios: [] };
  try {
    return yaml.load(readFileSync(PATHS.watchlist, 'utf8')) ?? { tracked_companies: [], portfolio_boards: [], fund_portfolios: [] };
  } catch (err) {
    throw new Error(`config/watchlist.yml is not valid YAML: ${err.message}`);
  }
}

export const enabled = (list) => (list ?? []).filter((c) => c && c.enabled !== false);

/**
 * Translate huntley's title rules into the early title_filter vocabulary.
 * Scanner keeps a superset of what huntley prefilter would keep.
 */
export function scannerTitleTerms(targets = {}) {
  const words = (term) => String(term).toLowerCase().replace(/\*$/, '')
    .split(/[\s\-_/,&()]+/).map((w) => w.replace(/[^\p{L}\p{N}]/gu, '')).filter(Boolean);

  const positive = [...new Set((targets.role_terms ?? [])
    .map((t) => words(t).sort((a, b) => b.length - a.length)[0])
    .filter(Boolean))];

  const excepted = new Set(Object.keys(targets.exclude_exceptions ?? {}).map((k) => k.trim().toLowerCase()));
  const negative = [...new Set((targets.exclude_titles ?? [])
    .map((t) => String(t).trim().toLowerCase())
    .filter((t) => t && !excepted.has(t))
    .map((t) => (t.endsWith('*') ? `stem:${t.slice(0, -1).trim()}` : `word:${t}`)))];

  return { positive, negative };
}

/**
 * Enabled watchlist companies as board entries for scanBoards.
 */
export function watchlistEntries(doc = loadWatchlist()) {
  return enabled(doc.tracked_companies).map(normalizeEntry).filter(Boolean);
}

export function portfolioBoardEntries(doc = loadWatchlist()) {
  return enabled(doc.portfolio_boards).map(normalizeEntry).filter(Boolean);
}

// Every provider option on the entry travels with it. The providers read
// their settings straight off the entry — consider_board, getro_max_age_days,
// max_pages, site, getro_collection, … — and watchlist.yml is where you set
// them. Copying only name/careers_url/provider/api silently dropped the rest:
// all seven Consider boards failed every run with "needs a 'consider_board'
// id" while watchlist.yml had one, and Getro boards paged back 90 days
// instead of the 7 you configured.
function normalizeEntry(c) {
  if (!c) return null;
  const name = c.name ?? c.company;
  const careers_url = c.careers_url;
  if (!name || !careers_url) return null;
  const { enabled: _enabled, company: _company, ...options } = c;
  const entry = { ...options, name, careers_url };
  if (!entry.provider) delete entry.provider;
  if (!entry.api) delete entry.api;
  return entry;
}

/**
 * The companies whose matching roles earn the watchlist bonus.
 */
export function watchlistCompanyKeys(companyKeyFn) {
  let doc;
  try { doc = loadWatchlist(); } catch { return new Set(); }
  return new Set(enabled(doc.tracked_companies)
    .map((e) => companyKeyFn(e.name ?? e.company ?? ''))
    .filter(Boolean));
}

/**
 * Append discovered companies to watchlist.yml (comment-preserving best-effort via full rewrite of tracked list).
 * Prefer splicing when possible; for Huntley we load/dump and preserve other top-level keys.
 */
export function appendWatchlistCompanies(newEntries) {
  const doc = loadWatchlist();
  const existing = new Set(
    (doc.tracked_companies ?? [])
      .map((c) => String(c?.careers_url || '').replace(/\/+$/, '').toLowerCase())
      .filter(Boolean),
  );
  const added = [];
  for (const e of newEntries) {
    const url = String(e.careers_url || '').replace(/\/+$/, '');
    if (!url || existing.has(url.toLowerCase())) continue;
    existing.add(url.toLowerCase());
    const row = { name: e.name, careers_url: e.careers_url, enabled: true };
    if (e.provider) row.provider = e.provider;
    if (e.api) row.api = e.api;
    doc.tracked_companies = [...(doc.tracked_companies ?? []), row];
    added.push(row);
  }
  if (added.length) {
    writeFileSync(PATHS.watchlist, yaml.dump(doc, { lineWidth: 100, noRefs: true }));
  }
  return added;
}
