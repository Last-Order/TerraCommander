import { createHash } from 'node:crypto';
import { mkdtempDisposable } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { DownloadOutput } from './download-output';

it('provides checksum snapshots without consuming subsequent writes', async () => {
  await using temporary = await mkdtempDisposable(join(tmpdir(), 'terra-output-'));
  const output = new DownloadOutput(
    join(temporary.path, 'file.bin'),
    temporary.path,
    false,
    'sha256',
  );
  const signal = new AbortController().signal;
  try {
    await output.open(signal);
    await output.write(Buffer.from('first'));
    const firstChecksum = output.contentChecksum;
    await output.write(Buffer.from('second'));
    expect(firstChecksum).toBe(createHash('sha256').update('first').digest('hex'));
    expect(output.contentChecksum).toBe(createHash('sha256').update('firstsecond').digest('hex'));
    expect(output.bytes).toBe(11);
    await output.verify(signal);
  } finally {
    await output.close();
    await output.cleanup(false);
  }
});
