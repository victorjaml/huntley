// Deterministic section-aware description excerpts for the rank prompt.
//
// Prefer responsibilities, qualifications, experience, and compensation when
// those sections exist. Blind prefix truncation hid qualifications that sat
// after boilerplate. Missing sections stay missing — never inferred.

export const MAX_DESCRIPTION_CHARS = 4000;

const SECTION_ALIASES = [
  {
    key: 'responsibilities',
    patterns: [
      /\b(responsibilities|what you.?ll do|what you will do|the role|about the role|in this role|your impact)\b/i,
    ],
  },
  {
    key: 'qualifications',
    patterns: [
      /\b(qualifications|requirements|what we.?re looking for|what we look for|you have|you.?ll have|must have|minimum qualifications|preferred qualifications)\b/i,
    ],
  },
  {
    key: 'experience',
    patterns: [
      /\b(experience|background|skills)\b/i,
    ],
  },
  {
    key: 'compensation',
    patterns: [
      /\b(compensation|salary|pay|benefits|perks|total rewards)\b/i,
    ],
  },
];

function normalizeWhitespace(text) {
  return String(text ?? '').replace(/\s+/g, ' ').trim();
}

/**
 * True when a short line is a section title, not body copy that happens to
 * mention "experience" / "skills" / "pay".
 */
export function isSectionHeading(line, patterns) {
  const heading = String(line ?? '').replace(/[:#*\-]+$/g, '').trim();
  if (!heading || heading.length > 60) return false;
  const words = heading.split(/\s+/).filter(Boolean);
  if (words.length === 0 || words.length > 6) return false;
  // Content lines: "5+ years experience with PyTorch"
  if (/\d/.test(heading)) return false;
  if (/[.!?;]/.test(heading)) return false;

  const QUALIFIER = /^(required|minimum|preferred|basic|additional|other|key|core)$/i;
  for (const re of patterns) {
    const m = heading.match(re);
    if (!m || m.index == null) continue;
    const beforeWords = heading.slice(0, m.index).trim().split(/\s+/).filter(Boolean);
    // "Competitive pay…" / "Total rewards package…" — content, not a heading.
    if (beforeWords.some((w) => !QUALIFIER.test(w.replace(/,/g, '')))) continue;
    const rest = heading.slice(m.index + m[0].length).replace(/[:#*\-\s,]+/g, '');
    // Allow "Skills, Knowledge and Abilities" / "Required Qualifications".
    if (rest.length <= 32) return true;
  }
  return false;
}

/**
 * Split posting text into named sections when heading-like lines are present.
 * Unsectioned prose becomes `body`.
 */
export function splitDescriptionSections(text) {
  const raw = String(text ?? '').replace(/\r\n/g, '\n').trim();
  if (!raw) return {};

  const lines = raw.split('\n');
  const sections = {};
  let current = 'body';
  sections[current] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    let matched = null;
    for (const section of SECTION_ALIASES) {
      if (isSectionHeading(trimmed, section.patterns)) {
        matched = section.key;
        break;
      }
    }
    if (matched) {
      current = matched;
      if (!sections[current]) sections[current] = [];
      continue;
    }
    if (!sections[current]) sections[current] = [];
    sections[current].push(line);
  }

  const out = {};
  for (const [key, parts] of Object.entries(sections)) {
    const textPart = normalizeWhitespace(parts.join('\n'));
    if (textPart) out[key] = textPart;
  }
  return out;
}

/**
 * Build a prompt excerpt of at most maxChars, preferring useful sections.
 * @param {string|null|undefined} description
 * @param {{maxChars?: number}} [opts]
 */
export function excerptDescription(description, { maxChars = MAX_DESCRIPTION_CHARS } = {}) {
  const normalized = normalizeWhitespace(description);
  if (!normalized) return '';
  if (normalized.length <= maxChars) return normalized;

  const sections = splitDescriptionSections(description);
  const order = ['responsibilities', 'qualifications', 'experience', 'compensation', 'body'];
  const parts = [];
  let used = 0;

  for (const key of order) {
    const text = sections[key];
    if (!text) continue;
    const label = key === 'body' ? null : key;
    const chunk = label ? `${label}: ${text}` : text;
    if (used >= maxChars) break;
    const room = maxChars - used - (parts.length ? 1 : 0);
    if (room <= 0) break;
    const take = chunk.length <= room ? chunk : `${chunk.slice(0, Math.max(0, room - 1)).trimEnd()}…`;
    if (!take) break;
    parts.push(take);
    used += take.length + (parts.length > 1 ? 1 : 0);
  }

  const joined = parts.join(' ').trim();
  return joined || normalized.slice(0, maxChars);
}
