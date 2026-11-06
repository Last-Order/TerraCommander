import { describe, expect, it } from 'vitest';
import { readGoogleClientConfiguration } from './client-configuration';
import { TEST_CLIENT_ID } from '../testing/fixtures';

describe('Google client configuration', () => {
  it('ignores client overrides in releases and validates development client identity', () => {
    const bundled = { clientId: TEST_CLIENT_ID };
    const overrides = { GOOGLE_DRIVE_CLIENT_ID: 'developer.apps.googleusercontent.com' };
    expect(readGoogleClientConfiguration(bundled, false, overrides)).toEqual(bundled);
    expect(readGoogleClientConfiguration(bundled, true, overrides)?.clientId).toBe(
      overrides.GOOGLE_DRIVE_CLIENT_ID,
    );
    expect(readGoogleClientConfiguration(undefined, true, {})).toBeUndefined();
    expect(() =>
      readGoogleClientConfiguration(bundled, true, {
        GOOGLE_DRIVE_CLIENT_ID: 'https://untrusted.test',
      }),
    ).toThrow(expect.objectContaining({ code: 'ClientConfigurationInvalid' }));
  });
});
