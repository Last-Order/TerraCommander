import { expect, it } from 'vitest';
import { en } from './en';
import { zhCN } from './zh-CN';

it('uses the same interpolation parameters in both translations', () => {
  const parameters = (text: string) =>
    new Set(Array.from(text.matchAll(/{{\s*([^}]+?)\s*}}/g), (match) => match[1]));
  for (const namespace of ['common', 'storage', 'errors'] as const) {
    const chinese = new Map(Object.entries(zhCN[namespace]));
    for (const [key, text] of Object.entries(en[namespace])) {
      expect(parameters(chinese.get(key) ?? ''), `${namespace}:${key}`).toEqual(parameters(text));
    }
  }
});
