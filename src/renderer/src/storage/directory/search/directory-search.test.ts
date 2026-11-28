import { describe, expect, it } from 'vitest';
import type { Entry } from '@shared/storage';
import type { DirectoryRow } from '../directory-types';
import { matchDirectoryRows } from './directory-search';

function createRow(locator: string, name = locator): DirectoryRow {
  const entry: Entry = {
    ref: { connectionId: 'local', spaceId: 'root', locator },
    name,
    kind: 'file',
    capabilities: {},
  };
  return { entry, name, modifiedAt: undefined, size: undefined };
}

const rows = [
  createRow('1', 'README.md'),
  createRow('2', 'readme.txt'),
  createRow('3', 'Report_01.pdf'),
  createRow('4', 'report_02.PDF'),
  createRow('5', 'notes [1].txt'),
];

describe('matchDirectoryRows', () => {
  it('returns empty matches for an empty query even in regex mode', () => {
    expect(matchDirectoryRows(rows, '', { caseSensitive: false, useRegex: false })).toEqual({
      matches: [],
      invalidPattern: false,
    });
    expect(matchDirectoryRows(rows, '', { caseSensitive: true, useRegex: true })).toEqual({
      matches: [],
      invalidPattern: false,
    });
  });

  it('matches plain substrings with optional case sensitivity', () => {
    expect(matchDirectoryRows(rows, 'README', { caseSensitive: false, useRegex: false })).toEqual({
      matches: ['1', '2'],
      invalidPattern: false,
    });
    expect(matchDirectoryRows(rows, 'README', { caseSensitive: true, useRegex: false })).toEqual({
      matches: ['1'],
      invalidPattern: false,
    });
    expect(matchDirectoryRows(rows, '[1]', { caseSensitive: false, useRegex: false })).toEqual({
      matches: ['5'],
      invalidPattern: false,
    });
  });

  it('matches regular expressions with optional case sensitivity', () => {
    expect(
      matchDirectoryRows(rows, '^report_\\d+\\.pdf$', { caseSensitive: false, useRegex: true }),
    ).toEqual({
      matches: ['3', '4'],
      invalidPattern: false,
    });
    expect(
      matchDirectoryRows(rows, '^Report_\\d+\\.pdf$', { caseSensitive: true, useRegex: true }),
    ).toEqual({
      matches: ['3'],
      invalidPattern: false,
    });
  });

  it('reports invalid regular expressions without throwing', () => {
    expect(matchDirectoryRows(rows, '[unclosed', { caseSensitive: false, useRegex: true })).toEqual(
      {
        matches: [],
        invalidPattern: true,
      },
    );
  });
});
