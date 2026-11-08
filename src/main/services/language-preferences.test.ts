import { mkdtempDisposable } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { createLanguagePreferences, resolveAppLanguage } from './language-preferences';

it('chooses the first supported system language and falls back to English', () => {
  expect(resolveAppLanguage('system', ['fr-FR', 'zh-Hans-CN', 'en-GB'])).toBe('zh-CN');
  expect(resolveAppLanguage('system', ['zh-Hant-TW', 'invalid!', 'en-GB', 'zh-CN'])).toBe('en');
  expect(resolveAppLanguage('system', ['fr-FR', 'zh-HK'])).toBe('en');
  expect(resolveAppLanguage('system', [])).toBe('en');
});

it('restores a saved preference over the system language and can return to system mode', async () => {
  await using profile = await mkdtempDisposable(join(tmpdir(), 'terra-language-'));
  const open = () => createLanguagePreferences(profile.path, () => ['zh-CN']);
  const initial = open();
  expect(initial.get()).toEqual({ preference: 'system', language: 'zh-CN' });
  expect(initial.set('en')).toEqual({ preference: 'en', language: 'en' });

  const restarted = open();
  expect(restarted.get()).toEqual({ preference: 'en', language: 'en' });
  expect(restarted.set('system')).toEqual({ preference: 'system', language: 'zh-CN' });
  expect(open().get()).toEqual({ preference: 'system', language: 'zh-CN' });
});
