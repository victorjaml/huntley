// @ts-check
// Shared HTML → plain-text pipeline for providers whose payloads embed
// description markup. Greenhouse's contentToText was the first instance;
// this is the extracted form so later providers cannot grow a divergent
// copy — same rationale that produced _html-entities when entity decoders
// drifted across four files (#1555/#1639/#2623).
import { decodeEntities } from './html-entities.mjs';
import { MAX_STORED_DESCRIPTION_CHARS } from '../../../normalize.mjs';

export { MAX_STORED_DESCRIPTION_CHARS };

// Compact mode only (non-description fields). Description mode uses
// MAX_STORED_DESCRIPTION_CHARS so qualifications after a long intro survive.
export const DESCRIPTION_CAP = 4000;

// A tag ends at an unquoted `>`. Attribute values may contain angle brackets,
// so the common `<[^>]+>` shortcut can stop midway through a tag and expose
// the remaining attributes as description text. Requiring content between the
// brackets preserves a literal `<>`, as the old matcher did.
const HTML_TAG_RE = /<(?:[^>"']|"[^"]*"|'[^']*')+>/g;
const HTML_MEDIA_RE = /<(script|style)\b(?:[^>"']|"[^"]*"|'[^']*')*>[\s\S]*?<\/\1\s*>/gi;

/** Block boundaries → newlines so section headings stay findable later. */
const BLOCK_BREAK_RE = /<(?:\/(?:p|div|h[1-6]|li|tr|section|article|header|footer|blockquote|ul|ol)|br\s*\/?)\s*>/gi;

/** @param {string} content */
function stripMarkup(content) {
  return content.replace(HTML_MEDIA_RE, ' ').replace(HTML_TAG_RE, ' ');
}

/**
 * @param {string} content
 * @param {{preserveBreaks?: boolean}} [opts]
 */
function finalizePlain(content, { preserveBreaks = false } = {}) {
  let text = content.replace(/<(?=\/?[a-z!?])/gi, '');
  if (preserveBreaks) {
    return text
      .replace(/\r\n/g, '\n')
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n[ \t]+/g, '\n')
      .replace(/[ \t]{2,}/g, ' ')
      .replace(/\n{3,}/g, '\n\n')
      .trim()
      .slice(0, MAX_STORED_DESCRIPTION_CHARS);
  }
  return text
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, DESCRIPTION_CAP);
}

/**
 * Entity-decoded markup → stripped plain text.
 *
 * Double-decode: the payload often carries entity-escaped tags (`&lt;p&gt;`),
 * so the first pass reveals real tags, and text-level entities (`&amp;`,
 * `&#39;`) only become decodable once those tags are gone.
 *
 * @param {unknown} content
 * @param {{mode?: 'compact'|'description'}} [opts]
 *   - `compact` (default): collapse all whitespace, cap at DESCRIPTION_CAP.
 *   - `description`: turn block tags into newlines, cap at MAX_STORED_DESCRIPTION_CHARS
 *     so the ranker still sees late sections (Qualifications, etc.).
 * @returns {string}
 */
export function htmlToText(content, { mode = 'compact' } = {}) {
  if (typeof content !== 'string' || !content) return '';

  if (mode === 'description') {
    // Reveal entity-escaped tags before inserting breaks — otherwise
    // `&lt;/p&gt;` would be stripped as text, not as a paragraph boundary.
    let s = decodeEntities(content);
    s = s.replace(BLOCK_BREAK_RE, '\n');
    s = stripMarkup(s);
    s = decodeEntities(s);
    s = stripMarkup(s);
    return finalizePlain(s, { preserveBreaks: true });
  }

  // Compact: strip literal markup before decoding so quote entities inside a
  // quoted attribute stay data rather than false delimiters.
  const decoded = decodeEntities(stripMarkup(content));
  const decodedTwice = decodeEntities(stripMarkup(decoded));
  return finalizePlain(decodedTwice, { preserveBreaks: false });
}
