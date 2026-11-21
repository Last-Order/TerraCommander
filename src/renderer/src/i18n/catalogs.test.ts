import { expect, it } from 'vitest';
import { rendererNamespaces } from './create-renderer-i18n';
import { en } from './en';
import { zhCN } from './zh-CN';

it('uses camelCase for all translation keys', () => {
  for (const namespace of rendererNamespaces) {
    for (const key of Object.keys(en[namespace])) {
      expect(key, `${namespace}:${key}`).toMatch(/^[a-z][a-zA-Z0-9]*$/);
    }
  }
});

it('uses the same interpolation parameters in both translations', () => {
  const parameters = (text: string) =>
    new Set(Array.from(text.matchAll(/{{\s*([^}]+?)\s*}}/g), (match) => match[1]));
  for (const namespace of rendererNamespaces) {
    const chinese = new Map(Object.entries(zhCN[namespace]));
    for (const [key, text] of Object.entries(en[namespace])) {
      expect(parameters(chinese.get(key) ?? ''), `${namespace}:${key}`).toEqual(parameters(text));
    }
  }
});
