import test from 'node:test';
import assert from 'node:assert/strict';
import { latexToText, replaceBackgroundSummary } from '../src/setup/cv.mjs';

test('latexToText keeps body prose and drops preamble markup', () => {
  const tex = String.raw`\documentclass{article}
\begin{document}
\section{Experience}
\textbf{Senior MLE} at Pinterest.
\begin{itemize}
\item Ranking and recommendations
\end{itemize}
\end{document}
`;
  const prose = latexToText(tex);
  assert.match(prose, /Senior MLE/);
  assert.match(prose, /Pinterest/);
  assert.match(prose, /Ranking and recommendations/);
  assert.doesNotMatch(prose, /documentclass|begin\{document\}|textbf/);
});

test('replaceBackgroundSummary rewrites only the summary block', () => {
  const before = `# prefs
background:
  summary: >
    Old summary that should disappear.
    Second line of the old one.

  strengths:
    - "ranking"

location:
  base: "LA"
`;
  const after = replaceBackgroundSummary(before, 'New summary about ML systems at Pinterest and a pivot into AI safety.');
  assert.match(after, /summary: >/);
  assert.match(after, /New summary about ML systems/);
  assert.doesNotMatch(after, /Old summary/);
  assert.match(after, /strengths:\n    - "ranking"/);
  assert.match(after, /base: "LA"/);
});

test('replaceBackgroundSummary replaces a one-line summary', () => {
  const before = `background:
  summary: "short old"
  domains:
    - "ml"
`;
  const after = replaceBackgroundSummary(before, 'A longer replacement paragraph.');
  assert.match(after, /A longer replacement paragraph/);
  assert.doesNotMatch(after, /short old/);
  assert.match(after, /domains:\n    - "ml"/);
});
