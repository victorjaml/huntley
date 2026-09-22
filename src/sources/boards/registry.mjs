// Explicit provider registry for Huntley board collection.
// Explicit `provider:` / `api` routing takes precedence over detect().

import greenhouse from './providers/greenhouse.mjs';
import lever from './providers/lever.mjs';
import ashby from './providers/ashby.mjs';
import workday from './providers/workday.mjs';
import icims from './providers/icims.mjs';
import getro from './providers/getro.mjs';
import consider from './providers/consider.mjs';
import builtin from './providers/builtin.mjs';
import hackernews from './providers/hackernews.mjs';
import jazzhr from './providers/jazzhr.mjs';
import gem from './providers/gem.mjs';
import personio from './providers/personio.mjs';
import bamboohr from './providers/bamboohr.mjs';
import smartrecruiters from './providers/smartrecruiters.mjs';
import workable from './providers/workable.mjs';
import recruitee from './providers/recruitee.mjs';
import breezy from './providers/breezy.mjs';
import pinpoint from './providers/pinpoint.mjs';
import rippling from './providers/rippling.mjs';
import join from './providers/join.mjs';
import jobvite from './providers/jobvite.mjs';
import teamtailor from './providers/teamtailor.mjs';
import avature from './providers/avature.mjs';
import oraclecloud from './providers/oraclecloud.mjs';
import phenom from './providers/phenom.mjs';

/** Deterministic registration order (also detect precedence). */
export const PROVIDER_MODULES = [
  greenhouse, lever, ashby, workday, icims, getro, consider, builtin, hackernews,
  jazzhr, gem, personio, bamboohr, smartrecruiters, workable, recruitee, breezy,
  pinpoint, rippling, join, jobvite, teamtailor, avature, oraclecloud, phenom,
];

let cached = null;

/** @returns {Map<string, object>} */
export function getProviders() {
  if (cached) return cached;
  const map = new Map();
  for (const p of PROVIDER_MODULES) {
    if (!p?.id || typeof p.fetch !== 'function') continue;
    if (map.has(p.id)) throw new Error(`duplicate provider id: ${p.id}`);
    map.set(p.id, p);
  }
  cached = map;
  return map;
}

/**
 * Resolve which provider handles a board entry.
 * Explicit `provider` wins; otherwise first successful detect() in registration order.
 *
 * @param {object} entry
 * @param {Map<string, object>} [providers]
 * @returns {{provider: object}|{error: string}|null}
 */
export function resolveProvider(entry, providers = getProviders()) {
  if (entry?.provider) {
    const p = providers.get(String(entry.provider));
    if (!p) return { error: `unknown provider: ${entry.provider}` };
    return { provider: p };
  }
  for (const p of providers.values()) {
    if (typeof p.detect !== 'function') continue;
    try {
      if (p.detect(entry)) return { provider: p };
    } catch {
      // detect must not throw the whole scan; skip this provider
    }
  }
  return null;
}

/** Provider ids registered for doctor/setup checks. */
export function registeredProviderIds() {
  return [...getProviders().keys()];
}
