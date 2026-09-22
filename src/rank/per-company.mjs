// At most N roles per company reach the model.
//
// A company posting seven matching roles in a day is one lead, not seven: the
// digest links to its job site, where the rest are a click away. Keeping the
// best few saves ranking calls and keeps one employer from filling the email.
//
// "Best" is the prefilter's heuristic — focus keywords, office location,
// freshness — since this runs before the model has scored anything. The kept
// roles carry how many others matched, so the digest can say "+4 more at
// Cohere" and the operator knows the site is worth a look. The watchlist gets
// the same cap.
//
// Capped roles stay unscored and retryable (run.mjs). They are not marked
// seen: a later run can still rank them when budget remains.

import { companyKey } from '../normalize.mjs';

/**
 * @param {object[]} jobs   prefilter survivors, best heuristic first
 * @param {number}   max    roles to keep per company; 0 or less keeps everything
 * @returns {{kept: object[], capped: object[]}}
 */
export function capPerCompany(jobs, max) {
  if (!Number.isFinite(max) || max <= 0) return { kept: jobs, capped: [] };

  const byCompany = new Map();
  for (const job of jobs) {
    const key = job.companyKey || companyKey(job.company) || job.company;
    if (!byCompany.has(key)) byCompany.set(key, []);
    byCompany.get(key).push(job);
  }

  const kept = [];
  const capped = [];
  for (const job of jobs) {
    const group = byCompany.get(job.companyKey || companyKey(job.company) || job.company);
    const rank = group.indexOf(job);
    if (rank < max) {
      const more = group.length - Math.min(max, group.length);
      kept.push(more ? { ...job, moreAtCompany: more } : job);
    } else {
      capped.push(job);
    }
  }
  return { kept, capped };
}
