// Discover company ATS boards. Default is print-only; --write updates watchlist.yml.

import { makeHttpCtx } from './http/http.mjs';
import { getProviders } from './registry.mjs';
import { loadWatchlist, appendWatchlistCompanies } from '../watchlist.mjs';

export const SLUG_RE = /^[A-Za-z0-9._-]+$/;

export function deriveSlug(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

const lower = (s) => String(s).toLowerCase();

/** Probe order: high-hit-rate first, then discover long-tail. */
export const VENDOR_ORDER = [
  'greenhouse', 'ashby', 'lever', 'workable', 'smartrecruiters',
  'recruitee', 'bamboohr', 'breezy', 'pinpoint', 'rippling', 'join',
];

function vendorBuilders(providers) {
  const lowerSlug = (s) => lower(s);
  return {
    greenhouse: {
      id: 'greenhouse',
      buildUrl: (s) => `https://job-boards.greenhouse.io/${s}`,
      api: (s) => `https://boards-api.greenhouse.io/v1/boards/${s}/jobs`,
      provider: providers.get('greenhouse'),
    },
    ashby: {
      id: 'ashby',
      buildUrl: (s) => `https://jobs.ashbyhq.com/${s}`,
      provider: providers.get('ashby'),
    },
    lever: {
      id: 'lever',
      buildUrl: (s) => `https://jobs.lever.co/${s}`,
      provider: providers.get('lever'),
    },
    workable: {
      id: 'workable',
      buildUrl: (s) => `https://apply.workable.com/${s}`,
      provider: providers.get('workable'),
    },
    smartrecruiters: {
      id: 'smartrecruiters',
      buildUrl: (s) => `https://careers.smartrecruiters.com/${s}`,
      provider: providers.get('smartrecruiters'),
    },
    recruitee: {
      id: 'recruitee',
      buildUrl: (s) => `https://${lowerSlug(s)}.recruitee.com`,
      provider: providers.get('recruitee'),
    },
    bamboohr: {
      id: 'bamboohr',
      buildUrl: (s) => `https://${lowerSlug(s)}.bamboohr.com/careers`,
      provider: providers.get('bamboohr'),
    },
    breezy: {
      id: 'breezy',
      buildUrl: (s) => `https://${lowerSlug(s)}.breezy.hr`,
      provider: providers.get('breezy'),
    },
    pinpoint: {
      id: 'pinpoint',
      buildUrl: (s) => `https://${lowerSlug(s)}.pinpointhq.com`,
      provider: providers.get('pinpoint'),
    },
    rippling: {
      id: 'rippling',
      buildUrl: (s) => `https://ats.rippling.com/${s}/jobs`,
      provider: providers.get('rippling'),
    },
    join: {
      id: 'join',
      buildUrl: (s) => `https://join.com/companies/${s}`,
      provider: providers.get('join'),
    },
  };
}

/**
 * @param {{name: string, slug?: string}} company
 * @param {{vendors?: string[], ctx?: object}} [opts]
 */
export async function resolveCompany(company, { vendors = VENDOR_ORDER, ctx = null } = {}) {
  const providers = getProviders();
  const builders = vendorBuilders(providers);
  const http = ctx ?? makeHttpCtx();
  const slug = company.slug || deriveSlug(company.name);
  if (!slug || !SLUG_RE.test(slug)) {
    return { company: company.name, resolved: false, reason: 'invalid slug' };
  }

  for (const id of vendors) {
    const v = builders[id];
    if (!v?.provider) continue;
    const entry = {
      name: company.name,
      careers_url: v.buildUrl(slug),
      provider: v.id,
    };
    if (v.api) entry.api = v.api(slug);
    try {
      const jobs = await v.provider.fetch(entry, { ...http, includeUndated: true });
      if (Array.isArray(jobs) && jobs.length > 0) {
        return {
          company: company.name,
          resolved: true,
          name: company.name,
          careers_url: entry.careers_url,
          api: entry.api,
          provider: v.id,
          jobCount: jobs.length,
        };
      }
    } catch {
      // try next vendor
    }
  }
  return { company: company.name, resolved: false, reason: 'no live board found' };
}

/**
 * Resolve many company names.
 * @param {string[]} names
 * @param {{write?: boolean, concurrency?: number}} [opts]
 */
export async function discoverBoards(names, { write = false, concurrency = 4 } = {}) {
  const companies = names.map((name) => ({ name: String(name).trim() })).filter((c) => c.name);
  const results = [];
  let i = 0;
  const workers = Array.from({ length: Math.min(concurrency, companies.length || 1) }, async () => {
    while (i < companies.length) {
      const c = companies[i++];
      results.push(await resolveCompany(c));
    }
  });
  await Promise.all(workers);

  const pending = results.filter((r) => r.resolved);
  let written = [];
  if (write && pending.length) {
    written = appendWatchlistCompanies(pending.map((r) => ({
      name: r.name,
      careers_url: r.careers_url,
      provider: r.provider,
      api: r.api,
    })));
  }

  return {
    results,
    pendingEntries: pending,
    written,
    unresolved: results.filter((r) => !r.resolved),
    watchlist: loadWatchlist(),
  };
}

/** CLI entry used by bin/huntley.mjs */
export async function runDiscoverBoardCli(argv) {
  const write = argv.includes('--write');
  const summary = argv.includes('--summary') || !argv.includes('--json');
  const names = argv.filter((a) => !a.startsWith('-'));
  if (!names.length) {
    console.error('Usage: huntley discover-board <Company> [Company...] [--write] [--summary]');
    process.exitCode = 1;
    return;
  }
  const out = await discoverBoards(names, { write });
  if (summary) {
    for (const r of out.results) {
      if (r.resolved) {
        console.log(`✓ ${r.name}: ${r.provider} — ${r.careers_url} (${r.jobCount} jobs)`);
      } else {
        console.log(`✗ ${r.company}: ${r.reason}`);
      }
    }
    if (write) console.log(`Wrote ${out.written.length} entr${out.written.length === 1 ? 'y' : 'ies'} to watchlist.yml`);
    else if (out.pendingEntries.length) console.log('(preview only — pass --write to update config/watchlist.yml)');
  } else {
    console.log(JSON.stringify(out, null, 2));
  }
}
