import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { slugCandidates, slugify } from '../src/venues/slug';

describe('venue slugs', () => {
  it('lowercases and hyphenates', () => {
    assert.equal(slugify('Smash Arena'), 'smash-arena');
  });

  it('drops punctuation rather than encoding it', () => {
    assert.equal(slugify('Smash Arena, HSR Layout'), 'smash-arena-hsr-layout');
    assert.equal(slugify("Raj's Turf & Courts"), 'raj-s-turf-courts');
  });

  it('strips accents instead of leaving them to percent-encoding', () => {
    assert.equal(slugify('Café Sportif'), 'cafe-sportif');
  });

  it('collapses runs and trims stray hyphens', () => {
    assert.equal(slugify('  --Smash   ---   Arena--  '), 'smash-arena');
  });

  it('never ends on a hyphen, even after truncation', () => {
    const slug = slugify('a'.repeat(58) + ' bcdef');
    assert.ok(slug.length <= 60);
    assert.ok(!slug.endsWith('-'), slug);
  });

  it('falls back to something usable when a name has no letters', () => {
    assert.equal([...slugCandidates('!!!')][0], 'venue');
  });

  it('offers numbered candidates for a clash', () => {
    const [first, second, third] = slugCandidates('Smash Arena');
    assert.deepEqual([first, second, third], ['smash-arena', 'smash-arena-2', 'smash-arena-3']);
  });
});
