// Digest rendering: one email, HTML + a plain-text alternative.
//
// Structure is fixed by what you asked for, in this order:
//   1. a status line you can trust — counts, sources reached, anything degraded
//   2. every match in one list, highest score first — a watchlist company earns
//      a score bonus (shown on its badge) rather than a separate section
//   3. a footer saying exactly what was filtered out and why
//
// A zero-match day still renders and still sends. That is the whole point: a
// silent inbox means the job failed, never that there was nothing to say.
//
// Email HTML is not web HTML — no external CSS, no flexbox/grid, inline styles
// on everything, tables for layout. Gmail strips <style> blocks in some clients
// and Outlook's renderer is Word. This is written for the worst reader.

import { actionUrl } from '../sheet/links.mjs';

const esc = (s) => String(s ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

const C = {
  ink: '#16181d',
  muted: '#6b7280',
  faint: '#9aa1ac',
  rule: '#e5e7eb',
  panel: '#f7f8fa',
  accent: '#1f5fd6',
  watch: '#b45309',
  watchBg: '#fffbeb',
  good: '#15803d',
};

function scoreBadge(score, heuristicOnly) {
  if (score == null) return '';
  const shown = Number(score).toFixed(1).replace(/\.0$/, '');
  const color = score >= 4.5 ? C.good : score >= 3.5 ? C.accent : C.muted;
  const title = heuristicOnly ? ' (heuristic — the ranker did not reach this one)' : '';
  return `<span style="display:inline-block;font:600 12px/1 -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:${color};border:1px solid ${color}33;background:${color}0f;border-radius:10px;padding:4px 8px;white-space:nowrap;"${title ? ` title="${esc(title.trim())}"` : ''}>${shown}${heuristicOnly ? '*' : ''}</span>`;
}

function ageLabel(job, today) {
  if (!job.postedAt) return '';
  const days = Math.round((Date.parse(`${today}T12:00:00Z`) - Date.parse(`${job.postedAt}T12:00:00Z`)) / 86_400_000);
  if (days <= 0) return 'posted today';
  if (days === 1) return 'posted yesterday';
  return `posted ${days}d ago`;
}

function jobRow(job, { today, links, showAdd = true }) {
  const add = links?.get(job.id) ?? null;
  const age = ageLabel(job, today);
  const meta = [job.location || null, age || null, job.sourceDetail || job.source].filter(Boolean);
  const limitedEvidence = !job.description
    || job.evidenceLevel === 'metadata_only';
  const evidenceNote = limitedEvidence
    ? `<div style="font:12px/1.5 -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:${C.faint};margin-top:6px;">Limited evidence: title, company and location only</div>`
    : '';

  const addCell = !showAdd
    ? ''
    : add
      ? `<a href="${esc(add)}" style="display:inline-block;font:600 13px/1 -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#ffffff;background:${C.accent};border-radius:6px;padding:9px 16px;text-decoration:none;white-space:nowrap;">Add</a>`
      : `<span style="font:12px/1.4 -apple-system,sans-serif;color:${C.faint};">Add unavailable</span>`;

  return `
<tr>
  <td style="padding:16px 0;border-top:1px solid ${C.rule};">
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">
      <tr>
        <td style="vertical-align:top;padding-right:12px;">
          <div style="font:600 16px/1.35 -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:${C.ink};">
            <a href="${esc(job.url)}" style="color:${C.ink};text-decoration:none;">${esc(job.title)}</a>
          </div>
          <div style="font:14px/1.5 -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:${C.ink};margin-top:3px;">
            ${esc(job.company)}${job.moreAtCompany ? ` <span style="font:13px/1 -apple-system,sans-serif;color:${C.muted};">· +${esc(job.moreAtCompany)} more matching role${job.moreAtCompany === 1 ? '' : 's'}</span>` : ''}${job.watchlist ? ` <span style="font:600 11px/1 -apple-system,sans-serif;color:${C.watch};background:${C.watchBg};border:1px solid ${C.watch}33;border-radius:4px;padding:3px 6px;vertical-align:1px;">WATCHLIST${job.bonus ? ` +${job.bonus}` : ''}</span>` : ''}
          </div>
          <div style="font:13px/1.5 -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:${C.muted};margin-top:4px;">
            ${esc(meta.join(' · '))}
          </div>
          ${job.why ? `<div style="font:14px/1.55 -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:${C.ink};margin-top:8px;">${esc(job.why)}</div>` : ''}
          ${evidenceNote}
          <div style="margin-top:10px;">
            <a href="${esc(job.url)}" style="font:13px/1 -apple-system,sans-serif;color:${C.accent};text-decoration:none;">View posting &rarr;</a>
          </div>
        </td>
        <td width="96" style="vertical-align:top;text-align:right;white-space:nowrap;">
          <div style="margin-bottom:10px;">${scoreBadge(job.score, job.heuristicOnly)}</div>
          ${addCell}
        </td>
      </tr>
    </table>
  </td>
</tr>`;
}

/**
 * @param {object} input
 * @param {object[]} input.jobs        ranked, above threshold, highest score first
 * @param {object}   input.stats       run counters
 * @param {string}   input.date
 * @param {string[]} input.warnings    anything degraded this run
 * @param {object}   input.config
 */
export function renderDigest({
  jobs, stats, date, warnings = [], config, unscored = [], belowThreshold = [], reportPath = null, coverageNotes = [],
}) {
  const secret = process.env.HUNTLEY_LINK_SECRET;
  const endpoint = config?.sheet?.webapp_url;
  const sheetEnabled = Boolean(config?.sheet?.enabled);

  const links = new Map();
  let linkError = null;
  if (sheetEnabled) {
    try {
      for (const job of jobs) {
        links.set(job.id, actionUrl({
          endpoint, secret, action: 'add', id: job.id,
          extra: { c: job.company.slice(0, 80), t: job.title.slice(0, 80), u: job.url },
        }));
      }
    } catch (err) {
      links.clear();
      linkError = err.message;
    }
  }

  const watchlistCount = jobs.filter((j) => j.watchlist).length;
  const allWarnings = [...warnings, ...(linkError ? [`Add buttons are off: ${linkError}`] : [])];

  const headline = jobs.length === 0
    ? 'No new matches today'
    : `${jobs.length} new match${jobs.length === 1 ? '' : 'es'}`;

  const subline = jobs.length === 0
    ? `Scanned ${stats.scanned} posting${stats.scanned === 1 ? '' : 's'} across ${stats.sources.length} source${stats.sources.length === 1 ? '' : 's'}. Nothing cleared your filters. This email is the proof the run happened.`
    : `${watchlistCount ? `${watchlistCount} from your watchlist. ` : ''}From ${stats.scanned} posting${stats.scanned === 1 ? '' : 's'} across ${stats.sources.length} source${stats.sources.length === 1 ? '' : 's'}.`;

  const html = `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>huntley — ${esc(date)}</title></head>
<body style="margin:0;padding:0;background:${C.panel};">
<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background:${C.panel};">
<tr><td align="center" style="padding:24px 12px;">
<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="600" style="width:100%;max-width:600px;background:#ffffff;border:1px solid ${C.rule};border-radius:10px;">
<tr><td style="padding:26px 26px 0;">

  <div style="font:600 12px/1 -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:${C.faint};letter-spacing:.14em;text-transform:uppercase;">huntley · ${esc(date)}</div>
  <div style="font:700 24px/1.25 -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:${C.ink};margin-top:10px;">${esc(headline)}</div>
  <div style="font:14px/1.6 -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:${C.muted};margin-top:7px;">${esc(subline)}</div>

  ${allWarnings.length ? `
  <div style="margin-top:16px;border:1px solid #f0c36d;background:#fffaf0;border-radius:7px;padding:12px 14px;">
    <div style="font:600 12px/1 -apple-system,sans-serif;color:#92400e;letter-spacing:.05em;text-transform:uppercase;">Run was degraded</div>
    <ul style="margin:8px 0 0;padding-left:18px;font:13px/1.6 -apple-system,sans-serif;color:#78350f;">
      ${allWarnings.map((w) => `<li>${esc(w)}</li>`).join('')}
    </ul>
  </div>` : ''}

</td></tr>

<tr><td style="padding:0 26px;">
<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">
  ${jobs.map((j) => jobRow(j, { today: date, links, showAdd: sheetEnabled })).join('')}
</table>
</td></tr>
${unscored.length ? `
<tr><td style="padding:8px 26px 0;">
  <div style="font:600 13px/1.4 -apple-system,sans-serif;color:${C.muted};">Unscored — ranking budget or company cap, retryable (${unscored.length})</div>
</td></tr>
<tr><td style="padding:0 26px;">
<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">
  ${unscored.map((j) => jobRow(j, { today: date, links, showAdd: sheetEnabled })).join('')}
</table>
</td></tr>` : ''}
${belowThreshold.length ? `
<tr><td style="padding:8px 26px 0;">
  <div style="font:600 13px/1.4 -apple-system,sans-serif;color:${C.muted};">Below score threshold (${belowThreshold.length})</div>
</td></tr>
<tr><td style="padding:0 26px;">
<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">
  ${belowThreshold.map((j) => jobRow(j, { today: date, links, showAdd: sheetEnabled })).join('')}
</table>
</td></tr>` : ''}

<tr><td style="padding:24px 26px 26px;">
  <div style="border-top:1px solid ${C.rule};padding-top:16px;font:12px/1.7 -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:${C.faint};">
    ${sheetEnabled
    ? `<div><strong style="color:${C.muted};">Add</strong> means “I want to apply”, not “I applied”. It writes the role to your tracker sheet. You apply yourself — huntley never submits anything.</div>`
    : `<div>Posting titles link to the employer. The tracker sheet is disabled, so there are no Add actions.</div>`}
    ${reportPath ? `<div style="margin-top:9px;">Complete local report: ${esc(reportPath)}</div>` : ''}
    ${coverageNotes.length ? `<div style="margin-top:9px;">Coverage: ${esc(coverageNotes.join(' · '))}</div>` : ''}
    <div style="margin-top:9px;">
      ${esc(stats.raw)} fetched &middot; ${esc(stats.collapsed)} duplicate${stats.collapsed === 1 ? '' : 's'} merged &middot;
      ${esc(stats.filtered)} filtered out &middot;${stats.cappedPerCompany ? ` ${esc(stats.cappedPerCompany)} beyond ${esc(stats.maxPerCompany)} per company &middot;` : ''} ${esc(stats.belowThreshold)} below score ${esc(stats.minScore)} &middot;
      ${esc(jobs.length)} shown
    </div>
    <div style="margin-top:5px;">Sources reached: ${esc(stats.sources.join(', ') || 'none')}${stats.failedSources?.length ? ` &middot; failed: ${esc(stats.failedSources.join(', '))}` : ''}</div>
    ${stats.rejectionSample?.length ? `<div style="margin-top:9px;color:${C.faint};">Filtered examples: ${stats.rejectionSample.map((r) => esc(`${r.title} — ${r.reason}`)).join(' · ')}</div>` : ''}
  </div>
</td></tr>

</table>
</td></tr></table>
</body></html>`;

  return { html, text: renderText({ jobs, stats, date, warnings: allWarnings, links, unscored, belowThreshold, reportPath, coverageNotes, sheetEnabled }), headline };
}

function renderText({ jobs, stats, date, warnings, links, unscored = [], belowThreshold = [], reportPath = null, coverageNotes = [], sheetEnabled = true }) {
  const lines = [`huntley — ${date}`, ''];

  lines.push(jobs.length === 0
    ? `No new matches today. Scanned ${stats.scanned} postings across ${stats.sources.length} sources. This email is the proof the run happened.`
    : `${jobs.length} new match${jobs.length === 1 ? '' : 'es'} from ${stats.scanned} postings across ${stats.sources.length} sources.`);

  if (warnings.length) {
    lines.push('', 'RUN WAS DEGRADED:', ...warnings.map((w) => `  ! ${w}`));
  }

  const block = (title, list) => {
    if (!list.length) return;
    lines.push('', title.toUpperCase(), '='.repeat(title.length));
    for (const job of list) {
      const score = job.score != null ? `${Number(job.score).toFixed(1)}${job.heuristicOnly ? '*' : ''}` : '—';
      const badge = job.watchlist ? `  [watchlist${job.bonus ? ` +${job.bonus}` : ''}]` : '';
      const more = job.moreAtCompany ? ` (+${job.moreAtCompany} more matching role${job.moreAtCompany === 1 ? '' : 's'})` : '';
      lines.push('', `[${score}] ${job.title} — ${job.company}${more}${badge}`);
      lines.push(`  ${[job.location, ageLabel(job, date), job.sourceDetail || job.source].filter(Boolean).join(' · ')}`);
      if (job.why) lines.push(`  ${job.why}`);
      if (!job.description || job.evidenceLevel === 'metadata_only') {
        lines.push('  Limited evidence: title, company and location only');
      }
      lines.push(`  ${job.url}`);
      const add = links?.get(job.id);
      if (add) lines.push(`  Add to tracker: ${add}`);
    }
  };

  block('Matches', jobs);
  block('Unscored (retryable)', unscored);
  block('Below threshold', belowThreshold);

  lines.push(
    '',
    '---',
    sheetEnabled
      ? 'Add means "I want to apply", not "I applied". You apply yourself; huntley never submits anything.'
      : 'Posting titles link to the employer. The tracker sheet is disabled, so there are no Add actions.',
    `${stats.raw} fetched · ${stats.collapsed} duplicates merged · ${stats.filtered} filtered · ${stats.cappedPerCompany ? `${stats.cappedPerCompany} beyond ${stats.maxPerCompany} per company · ` : ''}${stats.belowThreshold} below score ${stats.minScore} · ${jobs.length} shown`,
    `Sources reached: ${stats.sources.join(', ') || 'none'}${stats.failedSources?.length ? ` · failed: ${stats.failedSources.join(', ')}` : ''}`,
  );
  if (reportPath) lines.push(`Complete local report: ${reportPath}`);
  if (coverageNotes.length) lines.push(`Coverage: ${coverageNotes.join(' · ')}`);
  if (jobs.some((j) => j.heuristicOnly)) lines.push('* scored heuristically — the ranker did not reach this role.');

  return lines.join('\n');
}

export { esc as escapeHtml };
