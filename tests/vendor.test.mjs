// Board provider registry and Lever description contract (replaces vendor.test.mjs).

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { registeredProviderIds, resolveProvider, getProviders } from '../src/sources/boards/registry.mjs';
import { formatLeverDescription } from '../src/sources/boards/providers/lever.mjs';

describe('board providers', () => {
  it('registers core ATS providers', () => {
    const ids = registeredProviderIds();
    for (const id of ['greenhouse', 'lever', 'ashby', 'workday', 'icims', 'getro', 'consider', 'builtin', 'hackernews', 'jazzhr']) {
      assert.ok(ids.includes(id), `missing ${id}`);
    }
  });

  it('explicit provider wins over detect', () => {
    const r = resolveProvider({
      name: 'X',
      careers_url: 'https://job-boards.greenhouse.io/x',
      provider: 'lever',
    });
    assert.equal(r.provider.id, 'lever');
  });

  it('detects greenhouse from careers_url', () => {
    const r = resolveProvider({ name: 'X', careers_url: 'https://job-boards.greenhouse.io/acme' });
    assert.equal(r.provider.id, 'greenhouse');
  });

  it('Lever concatenates descriptionPlain + lists', () => {
    const text = formatLeverDescription({
      descriptionPlain: 'Intro paragraph.',
      lists: [{ text: 'Requirements', content: 'Know TypeScript' }],
    });
    assert.match(text, /Intro paragraph/);
    assert.match(text, /Requirements|Know TypeScript/);
  });

  it('htmlToText description mode keeps newlines and late sections past 4k', async () => {
    const { htmlToText, DESCRIPTION_CAP } = await import('../src/sources/boards/http/html-to-text.mjs');
    assert.match(htmlToText('&lt;p&gt;Know &amp; love TypeScript&lt;/p&gt;', { mode: 'description' }), /Know & love TypeScript/);
    const intro = 'x'.repeat(DESCRIPTION_CAP + 500);
    const text = htmlToText(
      `&lt;p&gt;${intro}&lt;/p&gt;&lt;h3&gt;Qualifications&lt;/h3&gt;&lt;p&gt;PyTorch&lt;/p&gt;`,
      { mode: 'description' },
    );
    assert.ok(text.length > DESCRIPTION_CAP);
    assert.match(text, /PyTorch/);
    assert.match(text, /\nQualifications\n/);
    assert.match(text, /\nPyTorch\n?/);
  });

  it('every registered provider has fetch', () => {
    for (const [id, p] of getProviders()) {
      assert.equal(typeof p.fetch, 'function', id);
    }
  });
});
