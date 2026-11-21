import { expect, it } from 'vitest';
import { listLocalVolumes, type LocalVolumeDeps } from './local-volumes';

function stubDeps(overrides: Partial<LocalVolumeDeps>): LocalVolumeDeps {
  return {
    platform: 'linux',
    async stat() {
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    },
    async readdir() {
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    },
    async realpath(path) {
      return path;
    },
    async readFile() {
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    },
    ...overrides,
  };
}

it('probes accessible Windows drive roots using fs stat', async () => {
  const existing = new Set(['C:\\', 'D:\\', 'Z:\\']);
  const volumes = await listLocalVolumes(
    undefined,
    stubDeps({
      platform: 'win32',
      async stat(path) {
        if (!existing.has(path)) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
        return { isDirectory: () => true };
      },
    }),
  );
  expect(volumes).toEqual(['C:\\', 'D:\\', 'Z:\\']);
});

it('discovers macOS volumes while skipping symlinks to root and degrading on errors', async () => {
  const volumes = await listLocalVolumes(
    undefined,
    stubDeps({
      platform: 'darwin',
      async readdir() {
        return [
          { name: 'Macintosh HD', isSymbolicLink: () => true },
          { name: 'Backup', isSymbolicLink: () => false },
          { name: 'Data Disk', isSymbolicLink: () => false },
          { name: 'not-a-dir', isSymbolicLink: () => false },
        ];
      },
      async realpath(path) {
        return path === '/Volumes/Macintosh HD' ? '/' : path;
      },
      async stat(path) {
        return { isDirectory: () => path !== '/Volumes/not-a-dir' };
      },
    }),
  );
  expect(volumes).toEqual(['/', '/Volumes/Backup', '/Volumes/Data Disk']);

  const degraded = await listLocalVolumes(undefined, stubDeps({ platform: 'darwin' }));
  expect(degraded).toEqual(['/']);
});

it('discovers Linux user mount points from /proc/mounts and unescapes octal sequences', async () => {
  const procMounts = [
    '/dev/nvme0n1p2 / ext4 rw,relatime 0 0',
    'tmpfs /run/media/alice/ephemeral tmpfs rw 0 0',
    '/dev/sdb1 /media/alice/My\\040Drive exfat rw 0 0',
    '/dev/sdc1 /mnt/backup ext4 rw 0 0',
    'overlay /mnt/overlay overlay rw 0 0',
    '/dev/sdd1 /run/media/alice/USB\\040Key vfat rw 0 0',
  ].join('\n');

  const volumes = await listLocalVolumes(
    undefined,
    stubDeps({
      platform: 'linux',
      async readFile() {
        return procMounts;
      },
    }),
  );
  expect(volumes).toEqual([
    '/',
    '/media/alice/My Drive',
    '/mnt/backup',
    '/run/media/alice/USB Key',
  ]);

  const degraded = await listLocalVolumes(undefined, stubDeps({ platform: 'linux' }));
  expect(degraded).toEqual(['/']);
});

it('honors pre-aborted signals', async () => {
  await expect(
    listLocalVolumes(AbortSignal.abort(), stubDeps({ platform: 'win32' })),
  ).rejects.toMatchObject({
    code: 'Cancelled',
  });
});
