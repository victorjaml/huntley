// The weekly proposal email.
//
// This email has one job: let you decide in thirty seconds whether to approve.
// So every change shows three things together — what would change, why, and the
// actual roles that produced the finding. A diff you cannot audit is a diff you
// should not approve, and an email that hides the evidence behind a link is one
// you will approve without reading.
//
// The APPROVE button is the only thing that applies anything. Reading this
// email changes nothing; ignoring it changes nothing.

import { escapeHtml as esc } from './render.mjs';

const C = {
  ink: '#16181d', muted: '#6b7280', faint: '#9aa1ac', rule: '#e5e7eb',
  add: '#15803d', remove: '#b91c1c', accent: '#1f5fd6', note: '#7c3aed',
};

function opLabel(change) {
  switch (change.op) {
    case 'add_note':         return { verb: 'Add a note',       color: C.note,   sign: '+' };
    case 'add_list_item':    return { verb: `Add to ${change.path}`,    color: C.add,    sign: '+' };
    case 'remove_list_item': return { verb: `Remove from ${change.path}`, color: C.remove, sign: '−' };
    case 'set_scalar':       return { verb: `Set ${change.path}`,       color: C.accent, sign: '~' };
    default:                 return { verb: change.op, color: C.muted, sign: '?' };
  }
}

function changeBlock(change, index) {
  const { verb, color, sign } = opLabel(change);

  return `
<tr><td style="padding:18px 0;border-top:1px solid ${C.rule};">
  <div style="font:600 11px/1 -apple-system,sans-serif;color:${C.faint};letter-spacing:.1em;text-transform:uppercase;">Change ${index + 1} · ${esc(verb)}</div>

  <div style="margin-top:10px;font:13px/1.6 ui-monospace,SFMono-Regular,Menlo,monospace;background:#f7f8fa;border:1px solid ${C.rule};border-left:3px solid ${color};border-radius:5px;padding:11px 13px;color:${color};">
    ${sign} ${esc(change.value)}
  </div>

  <div style="margin-top:11px;font:14px/1.6 -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:${C.ink};">
    ${esc(change.reason ?? '')}
  </div>

  ${change.evidence?.length ? `
  <div style="margin-top:9px;font:13px/1.6 -apple-system,sans-serif;color:${C.muted};">
    <span style="color:${C.faint};">Based on:</span>
    <ul style="margin:5px 0 0;padding-left:18px;">${change.evidence.map((e) => `<li>${esc(e)}</li>`).join('')}</ul>
  </div>` : ''}

  ${change.followUp ? `
  <div style="margin-top:9px;font:12px/1.6 ui-monospace,SFMono-Regular,Menlo,monospace;color:${C.muted};">
    Then run: <span style="background:#f3f4f6;padding:2px 5px;border-radius:3px;">${esc(change.followUp)}</span>
  </div>` : ''}

  ${change.fromModel ? `<div style="margin-top:8px;font:12px/1.5 -apple-system,sans-serif;color:${C.faint};">Written by the review model from your added-vs-ignored roles, not by a counting rule.</div>` : ''}
</td></tr>`;
}

export function renderProposalEmail({ proposal, evidence, date, approveLink, config }) {
  const s = proposal.summary;

  const approveButton = approveLink
    ? `<a href="${esc(approveLink)}" style="display:inline-block;font:600 15px/1 -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#fff;background:${C.add};border-radius:7px;padding:14px 28px;text-decoration:none;">APPROVE these ${proposal.changes.length} change${proposal.changes.length === 1 ? '' : 's'}</a>`
    : `<div style="font:14px/1.6 -apple-system,sans-serif;color:${C.remove};">The APPROVE link could not be built — the tracker sheet is not configured. To apply this by hand: <code style="background:#f3f4f6;padding:2px 5px;border-radius:3px;">huntley weekly --apply ${esc(proposal.id)}</code></div>`;

  const html = `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>huntley — proposed preference changes</title></head>
<body style="margin:0;background:#f7f8fa;">
<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background:#f7f8fa;">
<tr><td align="center" style="padding:24px 12px;">
<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="600" style="width:100%;max-width:600px;background:#fff;border:1px solid ${C.rule};border-radius:10px;">

<tr><td style="padding:26px 26px 0;">
  <div style="font:600 12px/1 -apple-system,sans-serif;color:${C.faint};letter-spacing:.14em;text-transform:uppercase;">huntley · weekly review · ${esc(date)}</div>
  <div style="font:700 23px/1.3 -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:${C.ink};margin-top:10px;">
    ${proposal.changes.length} proposed change${proposal.changes.length === 1 ? '' : 's'} to your preferences
  </div>
  <div style="font:14px/1.6 -apple-system,sans-serif;color:${C.muted};margin-top:8px;">
    From ${s.shown} roles shown over ${evidence.days} days: you added ${s.added}, ignored ${s.ignored}, and ${s.outcomes} have a recorded outcome. ${s.filteredOut} more were filtered out before you saw them.
  </div>

  <div style="margin-top:16px;border:1px solid #bfdbfe;background:#eff6ff;border-radius:7px;padding:12px 14px;font:13px/1.6 -apple-system,sans-serif;color:#1e3a8a;">
    <strong>Nothing has changed yet.</strong> These apply only when you click APPROVE below, and huntley writes them on its next run. Ignoring this email leaves your preferences exactly as they are.
  </div>
</td></tr>

<tr><td style="padding:12px 26px 0;">
<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">
  ${proposal.changes.map(changeBlock).join('')}
</table>
</td></tr>

<tr><td align="center" style="padding:28px 26px;">
  ${approveButton}
  <div style="margin-top:14px;font:12px/1.6 -apple-system,sans-serif;color:${C.faint};">
    Approving applies all ${proposal.changes.length}. To take only some, edit <code>config/preferences.yml</code> yourself — huntley reads your edits as ground truth.
  </div>
</td></tr>

<tr><td style="padding:0 26px 26px;">
  <div style="border-top:1px solid ${C.rule};padding-top:14px;font:12px/1.7 -apple-system,sans-serif;color:${C.faint};">
    Proposal <code>${esc(proposal.id)}</code> · stored at <code>data/proposals/${esc(proposal.id)}.json</code><br>
    A backup of preferences.yml is written before any change is applied, so this is always one <code>cp</code> from being undone.
  </div>
</td></tr>

</table>
</td></tr></table>
</body></html>`;

  const text = [
    `huntley weekly review — ${date}`,
    '',
    `${proposal.changes.length} proposed change(s) to your preferences.`,
    '',
    `From ${s.shown} roles shown over ${evidence.days} days: ${s.added} added, ${s.ignored} ignored, ${s.outcomes} with a recorded outcome. ${s.filteredOut} filtered out before you saw them.`,
    '',
    'NOTHING HAS CHANGED YET. These apply only when you click APPROVE.',
    '',
    ...proposal.changes.flatMap((change, i) => {
      const { verb, sign } = opLabel(change);
      return [
        `${'─'.repeat(60)}`,
        `CHANGE ${i + 1}: ${verb}`,
        `  ${sign} ${change.value}`,
        '',
        `  Why: ${change.reason ?? ''}`,
        ...(change.evidence?.length ? ['  Based on:', ...change.evidence.map((e) => `    - ${e}`)] : []),
        ...(change.followUp ? ['', `  Then run: ${change.followUp}`] : []),
        '',
      ];
    }),
    '─'.repeat(60),
    '',
    approveLink ? `APPROVE: ${approveLink}` : `To apply by hand: huntley weekly --apply ${proposal.id}`,
    '',
    `Proposal ${proposal.id} · data/proposals/${proposal.id}.json`,
    'A backup of preferences.yml is written before anything is applied.',
  ].join('\n');

  return { html, text };
}
