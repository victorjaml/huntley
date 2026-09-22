// Config loading. Two files, deliberately separate:
//
//   config/huntley.yml      plumbing — sources, email transport, schedules.
//                           You edit this. The weekly loop never touches it.
//   config/preferences.yml  the brain — titles, filters, watchlist, durable
//                           notes the ranker reads. The weekly loop proposes
//                           diffs HERE, and only applies them on APPROVE.
//
// Keeping them apart is what makes "do not silently rewrite scoring" checkable:
// any change to preferences.yml has a proposal behind it or it was you.
import { readFileSync, existsSync } from 'node:fs';
import * as yaml from 'js-yaml';
import { PATHS } from './lib/paths.mjs';
import { validateCollection } from './state/window.mjs';

try {
  const { config } = await import('dotenv');
  config({ path: `${PATHS.root}/.env`, quiet: true });
} catch { /* dotenv optional */ }

class ConfigError extends Error {}

function readYaml(path, label) {
  if (!existsSync(path)) {
    throw new ConfigError(
      `Missing ${label} at ${path}\n` +
      `  Copy the example and fill it in:  cp ${path.replace(/\.yml$/, '.example.yml')} ${path}`
    );
  }
  try {
    return yaml.load(readFileSync(path, 'utf8')) ?? {};
  } catch (err) {
    throw new ConfigError(`${label} is not valid YAML (${path}): ${err.message}`);
  }
}

/** Interpolate ${ENV_VAR} references so secrets live in .env, not in YAML. */
function expandEnv(value) {
  if (typeof value === 'string') {
    return value.replace(/\$\{([A-Z0-9_]+)\}/g, (_, name) => process.env[name] ?? '');
  }
  if (Array.isArray(value)) return value.map(expandEnv);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, expandEnv(v)]));
  }
  return value;
}

const DEFAULTS = {
  sources: {
    watchlist:   { enabled: true },
    portfolio_boards: { enabled: true },
    fund_portfolios: { enabled: true, since_days: 7, resolve_budget_seconds: 120, yc_pages: true, yc_max_age_days: 30, yc_budget_seconds: 300 },
    ats_dataset: { enabled: true, since_days: 3, ats: ['Greenhouse', 'Lever', 'Ashby', 'Workday', 'BambooHR', 'Paylocity'], max_age_hours: 48, fallback_sweep: ['greenhouse', 'lever', 'ashby'], name_budget_seconds: 90 },
    active_boards: { enabled: true, within_days: 90, since_days: 3 },
    freehire_feed: { enabled: false, countries: ['us'], open_within_days: 2, overlap_hours: 6 },
    builtin:     { enabled: false, markets: [], categories: ['dev-engineering', 'data-analytics'], max_pages: 4, since_days: 7 },
    hackernews:  { enabled: false },
    ats_sweep:   { enabled: false, since_days: 2, seeds: [], limit: null, ats: ['greenhouse', 'lever', 'ashby'], timeout_minutes: 30 },
    wellfound:   { enabled: false, roles: [], locations: [], max_age_days: 14, max_pages: 1, delay_ms: 6000, request_limit: 100 },
    linkedin:    { enabled: false, jobage_days: 1, max_pages: 1, delay_ms: 9000, queries: [], locations: [] },
    freehire:    { enabled: false, queries: [], limit: 50, max_pages: 1 },
    collection_lookback_days: 3,
  },
  rank: {
    cli: 'claude',
    model: null,
    max_llm: null,
    batch_size: 8,
    concurrency: 3,
    min_score: 3.0,
    watchlist_bonus: 0.5,
    max_per_company: 3,
    timeout_ms: 180000,
    // null = derive the deadline from max_llm / batch_size / concurrency /
    // timeout_ms, so it cannot fall out of step with them. A number is a hard
    // wall-clock cap, and is checked against the same arithmetic below.
    total_timeout_ms: null,
    cache: { enabled: true, ttl_hours: 168 },
  },
  enrichment: {
    enabled: true,
    max_jobs: 100,
    concurrency: 4,
    request_timeout_ms: 10000,
    total_timeout_ms: 60000,
    cache_ttl_hours: 24,
  },
  digest: {
    send_on_zero_matches: true,
    max_rows: 40,
    subject_prefix: 'huntley',
  },
  email: { provider: 'console', from_name: 'huntley' },
  sheet: { enabled: false },
  collection: {
    mode: 'since_last_success',
    initial_lookback_days: 30,
    overlap_hours: 48,
  },
};

function deepMerge(base, override) {
  const out = { ...base };
  for (const [k, v] of Object.entries(override ?? {})) {
    out[k] = (v && typeof v === 'object' && !Array.isArray(v) && base?.[k] && typeof base[k] === 'object' && !Array.isArray(base[k]))
      ? deepMerge(base[k], v)
      : v;
  }
  return out;
}

/**
 * Load and validate the full runtime config.
 * @param {{requirePreferences?: boolean}} [opts]
 */
export function loadConfig({ requirePreferences = true } = {}) {
  const raw = expandEnv(readYaml(PATHS.huntleyConfig, 'huntley config'));
  const cfg = deepMerge(DEFAULTS, raw);

  const prefs = requirePreferences
    ? expandEnv(readYaml(PATHS.preferences, 'preference memory'))
    : (existsSync(PATHS.preferences) ? expandEnv(readYaml(PATHS.preferences, 'preference memory')) : {});

  validate(cfg, prefs, { requirePreferences });
  return { ...cfg, preferences: prefs };
}

function validate(cfg, prefs, { requirePreferences }) {
  const problems = [];

  if (!cfg.identity?.email) problems.push('identity.email is required (where the digest goes)');
  if (!cfg.identity?.name) problems.push('identity.name is required');

  const provider = cfg.email?.provider;
  const KNOWN = ['console', 'resend', 'smtp', 'mailjet'];
  if (!KNOWN.includes(provider)) {
    problems.push(`email.provider must be one of ${KNOWN.join(', ')} (got ${JSON.stringify(provider)})`);
  }
  if (provider !== 'console' && !cfg.email?.from) {
    problems.push(`email.from is required for provider "${provider}"`);
  }

  const anySource = Object.values(cfg.sources ?? {}).some((s) => s?.enabled);
  if (!anySource) problems.push('at least one entry under sources must be enabled');

  problems.push(...validateRank(cfg.rank ?? {}));
  problems.push(...validateEnrichment(cfg.enrichment ?? {}));
  problems.push(...validateCollection(cfg.collection ?? {}));
  problems.push(...validateFreehireFeed(cfg.sources?.freehire_feed ?? {}));

  if (requirePreferences && !(prefs?.targets?.role_terms?.length > 0)) {
    problems.push('preferences.targets.role_terms must list at least one role word (e.g. "engineer*", "scientist") — a title must contain one to be considered');
  }
  if (requirePreferences) problems.push(...validateTargets(prefs?.targets ?? {}));
  if (requirePreferences) problems.push(...validateLocation(prefs?.location ?? {}));
  if (requirePreferences && prefs?.targets?.titles !== undefined) {
    problems.push('preferences.targets.titles is no longer used — move the role words into role_terms and the specific parts into title_keywords');
  }

  if (problems.length) {
    throw new ConfigError('Config problems:\n' + problems.map((p) => `  • ${p}`).join('\n'));
  }
}

function isPositiveInt(n) {
  return Number.isInteger(n) && n > 0;
}

export function validateRank(rank) {
  const problems = [];
  const maxLlm = rank.max_llm;
  if (maxLlm !== null && maxLlm !== undefined) {
    const n = Number(maxLlm);
    if (!Number.isInteger(n) || n < 0) {
      problems.push('rank.max_llm must be null (all eligible roles) or a nonnegative integer');
    }
  }
  const batch = Number(rank.batch_size);
  if (rank.batch_size !== undefined && !(Number.isInteger(batch) && batch > 0)) {
    problems.push('rank.batch_size must be a positive integer');
  }
  const concurrency = Number(rank.concurrency);
  if (rank.concurrency !== undefined && !(Number.isInteger(concurrency) && concurrency >= 1 && concurrency <= 4)) {
    problems.push('rank.concurrency must be an integer from 1 through 4');
  }
  if (rank.timeout_ms !== undefined && !isPositiveInt(Number(rank.timeout_ms))) {
    problems.push('rank.timeout_ms must be a positive finite integer');
  }
  // null is meaningful here: derive the deadline rather than fix it.
  if (rank.total_timeout_ms != null && !isPositiveInt(Number(rank.total_timeout_ms))) {
    problems.push('rank.total_timeout_ms must be null (derived) or a positive finite integer');
  }
  // Cross-field: a budget that cannot finish a single pass is a config error,
  // not a slow run. Every field below can be individually valid while the
  // combination guarantees that most batches die at the deadline.
  // Skipped when max_llm is null — the batch count is then unbounded by design.
  const effBatch = Number(rank.batch_size ?? DEFAULTS.rank.batch_size);
  const effConc = Number(rank.concurrency ?? DEFAULTS.rank.concurrency);
  const effCall = Number(rank.timeout_ms ?? DEFAULTS.rank.timeout_ms);
  const explicitTotal = rank.total_timeout_ms ?? DEFAULTS.rank.total_timeout_ms;
  const effTotal = Number(explicitTotal);
  const effMax = rank.max_llm === undefined ? DEFAULTS.rank.max_llm : rank.max_llm;
  // Only an explicit deadline can be wrong; a derived one is right by
  // construction.
  if (explicitTotal != null && effMax != null
    && [effBatch, effConc, effCall, effTotal].every((n) => Number.isFinite(n) && n > 0)
    && Number(effMax) > 0) {
    const waves = Math.ceil(Math.ceil(Number(effMax) / effBatch) / effConc);
    const needed = waves * effCall;
    if (needed > effTotal) {
      problems.push(`rank.total_timeout_ms (${effTotal}) cannot finish ranking: `
        + `max_llm ${effMax} / batch_size ${effBatch} is ${Math.ceil(Number(effMax) / effBatch)} call(s), `
        + `or ${waves} wave(s) at concurrency ${effConc}, needing ${needed}ms at timeout_ms ${effCall}. `
        + `Raise total_timeout_ms to at least ${needed}, lower max_llm/timeout_ms, `
        + 'or remove the key to let huntley derive it.');
    }
  }

  if (rank.cache != null) {
    if (typeof rank.cache !== 'object' || Array.isArray(rank.cache)) {
      problems.push('rank.cache must be a mapping');
    } else if (rank.cache.ttl_hours !== undefined && !(Number.isFinite(Number(rank.cache.ttl_hours)) && Number(rank.cache.ttl_hours) > 0)) {
      problems.push('rank.cache.ttl_hours must be a positive number');
    }
  }
  return problems;
}

export function validateEnrichment(enrichment) {
  const problems = [];
  if (!enrichment || typeof enrichment !== 'object') return problems;
  if (enrichment.max_jobs !== undefined && !(Number.isInteger(Number(enrichment.max_jobs)) && Number(enrichment.max_jobs) >= 0)) {
    problems.push('enrichment.max_jobs must be a nonnegative integer');
  }
  if (enrichment.concurrency !== undefined) {
    const c = Number(enrichment.concurrency);
    if (!Number.isInteger(c) || c < 1 || c > 8) {
      problems.push('enrichment.concurrency must be an integer from 1 through 8');
    }
  }
  for (const key of ['request_timeout_ms', 'total_timeout_ms']) {
    if (enrichment[key] !== undefined && !isPositiveInt(Number(enrichment[key]))) {
      problems.push(`enrichment.${key} must be a positive finite integer`);
    }
  }
  if (enrichment.cache_ttl_hours !== undefined && !(Number.isFinite(Number(enrichment.cache_ttl_hours)) && Number(enrichment.cache_ttl_hours) > 0)) {
    problems.push('enrichment.cache_ttl_hours must be a positive number');
  }
  return problems;
}

/**
 * Shape checks for the title rules.
 *
 * YAML is forgiving in exactly the wrong way here: a key inserted in the middle
 * of a list silently re-parents every item after it. That happened — a new key
 * landed inside exclude_titles and moved four exclusions under it, where they
 * excluded nothing, while the file still loaded cleanly. Each list must be a
 * list of strings, exclude_exceptions must map an EXCLUDED term to words, and
 * an exception for a term that is not excluded is reported, since it is either
 * a typo or a mis-nested block.
 */
export function validateTargets(targets) {
  const problems = [];
  const isStringList = (v) => Array.isArray(v) && v.every((x) => typeof x === 'string');

  for (const key of ['role_terms', 'exclude_titles', 'preferred_levels']) {
    if (targets[key] !== undefined && targets[key] !== null && !isStringList(targets[key])) {
      problems.push(`preferences.targets.${key} must be a list of strings`);
    }
  }

  // title_keywords: a flat list, or a map of group name → list.
  const tk = targets.title_keywords;
  const groupNames = new Set();
  if (tk !== undefined && tk !== null) {
    if (Array.isArray(tk)) {
      if (!isStringList(tk)) problems.push('preferences.targets.title_keywords must be a list of strings, or groups of them');
    } else if (typeof tk === 'object') {
      for (const [group, terms] of Object.entries(tk)) {
        groupNames.add(group);
        if (!isStringList(terms)) problems.push(`preferences.targets.title_keywords.${group} must be a list of strings`);
      }
    } else {
      problems.push('preferences.targets.title_keywords must be a list of strings, or groups of them');
    }
  }

  const ex = targets.exclude_exceptions;
  if (ex !== undefined && ex !== null) {
    if (typeof ex !== 'object' || Array.isArray(ex)) {
      problems.push('preferences.targets.exclude_exceptions must map an excluded term to words, e.g.  software engineer: [staff]  — it is a list, which usually means a key was inserted in the middle of another list');
    } else {
      const excluded = new Set((targets.exclude_titles ?? []).map((x) => String(x).trim().toLowerCase()));
      for (const [term, words] of Object.entries(ex)) {
        const list = [].concat(words ?? []);
        if (!list.length || !list.every((w) => typeof w === 'string')) {
          problems.push(`preferences.targets.exclude_exceptions["${term}"] must be a list of words`);
        }
        for (const ref of list.filter((w) => typeof w === 'string' && w.trim().startsWith('@'))) {
          if (!groupNames.has(ref.trim().slice(1))) {
            problems.push(`preferences.targets.exclude_exceptions["${term}"] refers to ${ref}, but title_keywords has no group by that name`);
          }
        }
        if (!excluded.has(term.trim().toLowerCase())) {
          problems.push(`preferences.targets.exclude_exceptions has an exception for "${term}", which is not in exclude_titles — a typo, or a mis-nested block`);
        }
      }
    }
  }

  const floor = targets.min_keyword_score;
  if (floor !== undefined && !(Number.isFinite(Number(floor)) && Number(floor) >= 0)) {
    problems.push('preferences.targets.min_keyword_score must be a number, 0 or more');
  }
  return problems;
}

/**
 * Location is the list of places you accept, and how remote roles are treated.
 * The keys this replaced are reported by name rather than silently ignored —
 * an ignored block list would look like it was still doing something.
 */
export function validateLocation(loc) {
  const problems = [];
  if (loc.allow !== undefined && !(Array.isArray(loc.allow) && loc.allow.every((x) => typeof x === 'string'))) {
    problems.push('preferences.location.allow must be a list of places, e.g. "California" or "Seattle, WA"');
  }
  if (loc.remote !== undefined && !['rank_lower', 'accept', 'exclude'].includes(loc.remote)) {
    problems.push('preferences.location.remote must be one of: rank_lower, accept, exclude');
  }
  for (const key of ['always_allow', 'block', 'block_hard', 'country_only']) {
    if (loc[key] !== undefined) {
      problems.push(`preferences.location.${key} is no longer used — list only the places you accept under location.allow; recognising everywhere else is huntley's job`);
    }
  }
  return problems;
}

export function validateFreehireFeed(feed = {}) {
  const problems = [];
  if (!feed || typeof feed !== 'object') return problems;
  if (feed.overlap_hours !== undefined) {
    const n = Number(feed.overlap_hours);
    if (!(Number.isFinite(n) && n >= 0)) {
      problems.push('sources.freehire_feed.overlap_hours must be a finite nonnegative number');
    }
  }
  return problems;
}

export { ConfigError };
