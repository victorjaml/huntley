// Real company names for roles that arrive named by board slug.
//
// The downloaded ATS dataset calls Northrop Grumman "ngc" and DiDi "didi". A
// block list of employer names cannot match a slug, and a digest row reading
// "ngc" tells you nothing, so every role that survives the prefilter has its
// name looked up from the board that posted it:
//
//   greenhouse  the board API's own `name`
//   workday     the job's detail API: its organisation ("General Motors LLC")
//               and its career-site name ("Northrop_Grumman_External_Site"),
//               since the organisation is sometimes an internal unit
//   the rest    the board page's <title> ("Cognition Jobs" → "Cognition")
//
// One lookup per board, cached for six months (a week when it failed), and
// only for roles that passed the filters — a few hundred a day at most.

import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync } from 'node:fs';
import { dirname } from 'node:path';
import { extractBoards } from './funds/boards.mjs';
import { nameFromTitle } from './funds/resolve.mjs';
import { companyKey } from '../normalize.mjs';

const DAY = 86_400_000;
const TTL_FOUND = 180 * DAY;
const TTL_FAILED = 7 * DAY;

/** The Workday job-detail API URL for a public job URL, or null. */
export function workdayDetailApi(jobUrl) {
  let u;
  try { u = new URL(jobUrl); } catch { return null; }
  const host = u.hostname.match(/^([a-z0-9-]+)\.wd\d{1,3}\.myworkdayjobs\.com$/i);
  if (!host) return null;
  const parts = u.pathname.split('/').filter(Boolean);
  if (/^[a-z]{2}-[A-Z]{2}$/.test(parts[0] ?? '')) parts.shift();
  const jobAt = parts.indexOf('job');
  if (jobAt < 1) return null;
  return `https://${u.hostname}/wday/cxs/${host[1]}/${parts[0]}/${parts.slice(jobAt).join('/')}`;
}

/**
 * The brand in a Workday career-site name: "Northrop_Grumman_External_Site" →
 * "Northrop Grumman", "NVIDIAExternalCareerSite" → "NVIDIA". null when nothing
 * but boilerplate is left ("External", "careers_gm" → "gm" is kept).
 */
export function workdaySiteName(site) {
  const words = String(site ?? '')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .split(/[\s_\-]+/)
    .filter((w) => w && !/^(external|internal|career|careers|site|sites|jobs?|portal|en|us|global|experienced|professional|opportunities|search|page|home)$/i.test(w));
  const name = words.join(' ').trim();
  return name.length >= 2 ? name : null;
}

/**
 * Workday's own organisation name is a legal entity ("General Motors LLC"),
 * often prefixed with an internal code ("2100 NVIDIA USA", "ADUS-Adobe Inc.")
 * and sometimes only an internal unit ("0090 CORP-Corporate Office"). The code
 * is dropped; a unit name is not a company name at all.
 */
export function workdayOrgName(name) {
  const t = String(name ?? '')
    .replace(/^\d{2,6}\s+/, '')               // "2100 NVIDIA USA"
    .replace(/^[A-Z0-9]{2,6}-(?=[A-Z])/, '')    // "ADUS-Adobe Inc."
    .trim();
  if (!t || /^\d/.test(t) || /corporate office|^corp\b/i.test(t)) return null;
  return t;
}

/** @returns {Promise<{name: string|null, aliases: string[]}>} */
async function lookup(job, board, http) {
  if (board.vendor === 'greenhouse') {
    const doc = await http.fetchJson(`https://boards-api.greenhouse.io/v1/boards/${board.slug}`, { timeoutMs: 10_000 });
    const name = doc?.name ? String(doc.name).trim() : null;
    return { name, aliases: [name].filter(Boolean) };
  }
  if (board.vendor === 'workday') {
    const api = workdayDetailApi(job.url);
    let org = null, site = null;
    if (api) {
      const doc = await http.fetchJson(api, { timeoutMs: 15_000, headers: { accept: 'application/json' } });
      org = doc?.hiringOrganization?.name ?? null;
      // externalUrl keeps the site name's original capitalisation.
      try { site = new URL(doc?.jobPostingInfo?.externalUrl ?? job.url).pathname.split('/').filter(Boolean).find((p) => !/^[a-z]{2}-[A-Z]{2}$/.test(p)); } catch { /* none */ }
    }
    const fromOrg = workdayOrgName(org), fromSite = workdaySiteName(site);
    // Every name the board goes by is checked against the block list, so an
    // employer is caught whichever of them its name is spelled in.
    return { name: fromOrg ?? fromSite, aliases: [org, fromOrg, fromSite].filter(Boolean) };
  }
  if (!http.fetchTextHead) return { name: null, aliases: [] };
  const head = await http.fetchTextHead(board.careers_url, { timeoutMs: 10_000, maxBytes: 16_384 });
  const name = nameFromTitle(head.match(/<title[^>]*>([^<]{1,200})<\/title>/i)?.[1]);
  return { name, aliases: [name].filter(Boolean) };
}

/**
 * Replace slug company names with real ones, in place.
 *
 * @param {object[]} jobs    jobs with `companySlug: true` are looked up
 * @param {object}   opts
 * @param {object}   opts.http        {fetchJson, fetchTextHead}
 * @param {string}   opts.cachePath
 * @param {number}   [opts.concurrency]
 * @param {number}   [opts.budgetMs]
 * @param {number}   [opts.now]
 * @returns {Promise<{resolved: number, fromCache: number, unresolved: number}>}
 */
export async function resolveCompanyNames(jobs, { http, cachePath, concurrency = 8, budgetMs = 90_000, now = Date.now() } = {}) {
  let cache = {};
  try { if (existsSync(cachePath)) cache = JSON.parse(readFileSync(cachePath, 'utf8')); } catch { cache = {}; }

  const byBoard = new Map();
  for (const job of jobs) {
    if (!job.companySlug) continue;
    const board = job.board ?? extractBoards(job.url)[0];
    if (!board) continue;
    if (!byBoard.has(board.careers_url)) byBoard.set(board.careers_url, { board, jobs: [] });
    byBoard.get(board.careers_url).jobs.push(job);
  }

  const fresh = (hit) => hit && now - hit.checkedAt < (hit.name ? TTL_FOUND : TTL_FAILED);
  const todo = [...byBoard.entries()].filter(([url]) => !fresh(cache[url]));
  const deadline = Date.now() + budgetMs;
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, todo.length) }, async () => {
    while (i < todo.length && Date.now() < deadline) {
      const [url, { board, jobs: boardJobs }] = todo[i++];
      // A role can close between the dataset's crawl and now; try a few.
      let found = { name: null, aliases: [] };
      for (const job of boardJobs.slice(0, 3)) {
        try { found = await lookup(job, board, http); } catch { continue; }
        if (found.name) break;
      }
      cache[url] = { ...found, checkedAt: Date.now() };
    }
  }));

  let resolved = 0, unresolved = 0;
  for (const [url, { board, jobs: boardJobs }] of byBoard) {
    const name = cache[url]?.name;
    for (const job of boardJobs) {
      job.companyAliases = [...new Set([board.slug.split('|')[0], ...(cache[url]?.aliases ?? [])])];
      if (name) {
        job.company = name;
        job.companyKey = companyKey(name);
        delete job.companySlug;
        resolved++;
      } else {
        unresolved++;
      }
    }
  }

  mkdirSync(dirname(cachePath), { recursive: true });
  writeFileSync(`${cachePath}.tmp`, JSON.stringify(cache));
  renameSync(`${cachePath}.tmp`, cachePath);
  return { resolved, fromCache: byBoard.size - todo.length, unresolved };
}
