// Early collection filters — keep a superset of Huntley's final accepted jobs.

import { buildTitleFilter } from './title-keywords.mjs';
import { scannerTitleTerms } from '../watchlist.mjs';
import { isoDate } from '../../normalize.mjs';

/**
 * Build the early title filter from preferences (same vocabulary portals-gen used).
 * @param {object} prefs
 * @returns {(title: string) => boolean}
 */
export function titleFilterFromPrefs(prefs) {
  const { positive, negative } = scannerTitleTerms(prefs?.targets ?? {});
  return buildTitleFilter({ positive, negative });
}

function postedMs(postedAt) {
  if (postedAt == null || postedAt === '') return null;
  if (typeof postedAt === 'number' && Number.isFinite(postedAt)) return postedAt;
  const iso = isoDate(postedAt);
  if (!iso) return null;
  const ms = Date.parse(`${iso}T12:00:00Z`);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * Keep postings within sinceDays, or undated (Huntley/scan includeUndated behavior).
 * @param {unknown} postedAt  epoch ms, ISO string, or null
 * @param {number|null} sinceDays
 * @param {number} [now]
 */
export function withinSince(postedAt, sinceDays, now = Date.now()) {
  if (sinceDays == null || !(sinceDays > 0)) return true;
  if (postedAt == null || postedAt === '') return true; // undated kept
  const ms = postedMs(postedAt);
  if (ms == null) return true;
  return ms >= now - sinceDays * 86_400_000;
}

/**
 * Inclusive [sinceMs, untilMs] window against a frozen clock. Undated jobs stay.
 * Pass sinceMs null for an unbounded current inventory.
 */
export function withinWindow(postedAt, sinceMs, untilMs = null, { includeUndated = true } = {}) {
  if (sinceMs == null) return true;
  if (postedAt == null || postedAt === '') return includeUndated;
  const ms = postedMs(postedAt);
  if (ms == null) return includeUndated;
  if (ms < sinceMs) return false;
  if (untilMs != null && ms > untilMs) return false;
  return true;
}

/** Normalize provider postedAt (epoch or string) to YYYY-MM-DD or null. */
export function postedAtIso(postedAt) {
  if (postedAt == null || postedAt === '') return null;
  if (typeof postedAt === 'number' && Number.isFinite(postedAt)) {
    return new Date(postedAt).toISOString().slice(0, 10);
  }
  return isoDate(postedAt);
}
