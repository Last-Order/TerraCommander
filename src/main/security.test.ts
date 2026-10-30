import { describe, expect, it } from 'vitest';
import { isTrustedRenderer } from './security';

describe('renderer URL verification', () => {
  const development = 'http://localhost:5173/';
  const production = 'file:///D:/TerraCommander/out/renderer/index.html';

  it('accepts the configured entry and in-page navigation', () => {
    expect(isTrustedRenderer(development, development)).toBe(true);
    expect(isTrustedRenderer(`${production}#settings`, production)).toBe(true);
  });

  it.each([
    'https://example.com/',
    'http://localhost:5174/',
    'http://localhost:5173/other.html',
    'http://user:secret@localhost:5173/',
    'javascript:alert(1)',
    'not a URL',
  ])('rejects other origins, documents and credentials: %s', (candidate) => {
    expect(isTrustedRenderer(candidate, development)).toBe(false);
  });

  it('does not trust other file URLs just because their origins are null', () => {
    expect(isTrustedRenderer('file:///D:/Downloads/other.html', production)).toBe(false);
    expect(
      isTrustedRenderer('file://remote/TerraCommander/out/renderer/index.html', production),
    ).toBe(false);
  });
});
