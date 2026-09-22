// One-shot resume import for setup.
//
// Ranking reads only preferences.yml. A resume is useful once: strip it to
// prose, summarise it into background.summary, and stop. Live cv.path support
// was removed so morning runs never depend on Google Drive mounts or Full Disk
// Access.

import { readFileSync, writeFileSync, copyFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, extname } from 'node:path';
import { PATHS } from '../lib/paths.mjs';
import { log } from '../lib/log.mjs';
import { detectCli, askCli } from '../rank/llm.mjs';

/** Strip LaTeX to readable prose. Not a parser — a de-noiser. */
export function latexToText(tex) {
  return String(tex)
    .replace(/^[\s\S]*?\\begin\{document\}/, '')
    .replace(/\\end\{document\}[\s\S]*$/, '')
    .replace(/(^|[^\\])%.*$/gm, '$1')
    .replace(/\\(?:href|url)\{[^}]*\}\{([^}]*)\}/g, '$1')
    .replace(/\\(?:textbf|textit|emph|underline|texttt|textsc|mbox|item)\s*\{([^{}]*)\}/g, '$1')
    .replace(/\\(?:section|subsection|subsubsection|chapter|paragraph)\*?\{([^{}]*)\}/g, '\n\n## $1\n')
    .replace(/\\item\b/g, '\n- ')
    .replace(/\\(?:begin|end)\{[^}]*\}/g, '\n')
    .replace(/\\[a-zA-Z@]+\s*(\[[^\]]*\])?\s*\{([^{}]*)\}/g, '$2')
    .replace(/\\[a-zA-Z@]+\*?/g, ' ')
    .replace(/[{}]/g, ' ')
    .replace(/\\\\/g, '\n')
    .replace(/~/g, ' ')
    .replace(/\$[^$]*\$/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Newest .tex/.md/.txt in a directory, so "the resume folder" is a valid path. */
function newestSourceIn(dir) {
  const candidates = readdirSync(dir)
    .filter((f) => ['.tex', '.md', '.txt'].includes(extname(f).toLowerCase()))
    .map((f) => {
      const p = join(dir, f);
      try { return { p, mtime: statSync(p).mtimeMs }; } catch { return null; }
    })
    .filter(Boolean)
    .sort((a, b) => b.mtime - a.mtime);
  return candidates[0]?.p ?? null;
}

/**
 * Read a resume path (file or directory) as plain text.
 * @returns {{ path: string, text: string }}
 */
export function readCvSource(configured) {
  if (!configured) throw new Error('no resume path given');
  if (!existsSync(configured)) throw new Error(`resume not found: ${configured}`);

  const path = statSync(configured).isDirectory() ? newestSourceIn(configured) : configured;
  if (!path) throw new Error(`no .tex/.md/.txt file in ${configured}`);

  const source = readFileSync(path, 'utf8');
  const text = extname(path).toLowerCase() === '.tex' ? latexToText(source) : source.trim();
  if (!text) throw new Error(`resume is empty after reading ${path}`);
  return { path, text };
}

const SUMMARIZE_PROMPT = (prose) => `Summarize this resume into one dense paragraph (3–6 sentences) for a job-search preference file.

Include: years of experience, recent role and company, the technical focus of that work, earlier relevant roles if they matter, education if notable, and what the person wants next if the resume states it. Write in the third person or as a direct profile ("Machine learning engineer with…"). Do not use bullet points, markdown headings, or first person. Invent nothing.

Return ONLY the paragraph — no preamble, no quotes, no labels.

# Resume

${prose}`;

/**
 * Turn resume prose into a short background.summary via the ranking CLI, or a
 * truncated extract when no CLI is installed.
 */
export async function summarizeResume(prose, { cli, model, timeoutMs = 120_000 } = {}) {
  const trimmed = String(prose).replace(/\s+/g, ' ').trim().slice(0, 12_000);
  const candidate = await detectCli(cli);
  if (!candidate) {
    log.warn('no agent CLI found — writing a truncated resume extract; edit background.summary by hand');
    return fallbackSummary(trimmed);
  }

  log.step(`summarising resume via ${candidate.bin}`);
  const res = await askCli(candidate, SUMMARIZE_PROMPT(trimmed), { model, timeoutMs });
  if (!res.ok) {
    log.warn(`resume summarise failed (${res.error}) — writing a truncated extract instead`);
    return fallbackSummary(trimmed);
  }

  const paragraph = String(res.stdout)
    .replace(/^```[\s\S]*?```$/m, (block) => block.replace(/^```(?:\w+)?\n?/, '').replace(/\n?```$/, ''))
    .replace(/^["']|["']$/g, '')
    .replace(/\s+/g, ' ')
    .trim();

  if (paragraph.length < 40) {
    log.warn('resume summarise returned almost nothing — writing a truncated extract instead');
    return fallbackSummary(trimmed);
  }
  return paragraph.slice(0, 2000);
}

function fallbackSummary(prose) {
  const cut = prose.slice(0, 900);
  const lastStop = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('; '));
  return (lastStop > 200 ? cut.slice(0, lastStop + 1) : cut).trim();
}

/**
 * Replace preferences.yml background.summary, preserving surrounding comments.
 * Backs up the previous file under data/proposals/.
 */
export function writeBackgroundSummary(summary) {
  if (!existsSync(PATHS.preferences)) {
    throw new Error('config/preferences.yml does not exist — run huntley setup first');
  }

  const original = readFileSync(PATHS.preferences, 'utf8');
  const backup = join(PATHS.proposals, `preferences.before-cv-import.yml`);
  copyFileSync(PATHS.preferences, backup);

  const next = replaceBackgroundSummary(original, summary);
  writeFileSync(PATHS.preferences, next);
  return { backup, chars: summary.length };
}

/** Pure text edit used by writeBackgroundSummary (and tests). */
export function replaceBackgroundSummary(yamlText, summary) {
  const lines = yamlText.split('\n');
  let bg = -1;
  for (let i = 0; i < lines.length; i++) {
    if (/^background:\s*(#.*)?$/.test(lines[i])) { bg = i; break; }
  }
  if (bg === -1) throw new Error('preferences.yml has no background: block');

  let key = -1;
  for (let i = bg + 1; i < lines.length; i++) {
    const line = lines[i];
    if (/^\S/.test(line) && !line.trim().startsWith('#')) break;
    if (/^ {2}summary:\s*/.test(line)) { key = i; break; }
  }
  if (key === -1) throw new Error('preferences.yml has no background.summary');

  // Value runs until the next key at indent ≤ 2 (strengths:, domains:, …).
  let end = key + 1;
  while (end < lines.length) {
    const line = lines[end];
    if (!line.trim()) { end++; continue; }
    if (/^ {0,2}#/.test(line)) { end++; continue; }
    const indent = line.match(/^ */)[0].length;
    if (indent <= 2 && /^ {0,2}[A-Za-z_][\w-]*:/.test(line)) break;
    if (indent <= 2 && !line.trim().startsWith('#')) break;
    end++;
  }

  const folded = foldSummary(summary);
  const replacement = [`  summary: >`, ...folded.map((l) => `    ${l}`)];
  lines.splice(key, end - key, ...replacement);
  return lines.join('\n');
}

/** Soft-wrap a paragraph for a YAML folded scalar. */
function foldSummary(summary) {
  const words = String(summary).replace(/\s+/g, ' ').trim().split(' ');
  const out = [];
  let line = '';
  for (const w of words) {
    const next = line ? `${line} ${w}` : w;
    if (next.length > 78 && line) { out.push(line); line = w; }
    else line = next;
  }
  if (line) out.push(line);
  return out.length ? out : [''];
}
