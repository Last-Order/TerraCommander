import { describe, expect, it } from 'vitest';
import { readGoogleClientConfiguration } from './client-configuration';
import { TEST_CLIENT_ID } from '../testing/fixtures';

describe('Google client configuration', () => {
  it('validates the configured client and permits an omitted secret or unconfigured provider', () => {
    expect(readGoogleClientConfiguration(TEST_CLIENT_ID)).toEqual({ clientId: TEST_CLIENT_ID });
    expect(readGoogleClientConfiguration(TEST_CLIENT_ID, 'desktop-secret')).toEqual({
      clientId: TEST_CLIENT_ID,
      clientSecret: 'desktop-secret',
    });
    expect(readGoogleClientConfiguration(undefined)).toBeUndefined();
    expect(readGoogleClientConfiguration('')).toBeUndefined();
    expect(() => readGoogleClientConfiguration('https://untrusted.test')).toThrow(
      expect.objectContaining({ code: 'ClientConfigurationInvalid' }),
    );
  });
});
