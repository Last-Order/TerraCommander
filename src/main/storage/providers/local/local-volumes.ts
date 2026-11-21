import type { Dirent, Stats } from 'node:fs';
import { readdir, readFile, realpath, stat } from 'node:fs/promises';
import { posix } from 'node:path';
import { throwIfAborted } from '@main/storage/core/errors';

export interface LocalVolumeDeps {
  readonly platform: NodeJS.Platform;
  stat(path: string): Promise<Pick<Stats, 'isDirectory'>>;
  readdir(
    path: string,
    options: { withFileTypes: true },
  ): Promise<Pick<Dirent, 'name' | 'isSymbolicLink'>[]>;
  realpath(path: string): Promise<string>;
  readFile(path: string, encoding: 'utf8'): Promise<string>;
}

const defaultLocalVolumeDeps: LocalVolumeDeps = {
  get platform() {
    return process.platform;
  },
  stat: (path) => stat(path),
  readdir: (path, options) => readdir(path, options),
  realpath: (path) => realpath(path),
  readFile: (path, encoding) => readFile(path, encoding),
};

const windowsDriveLetters = Array.from(
  { length: 26 },
  (_, index) => `${String.fromCharCode(65 + index)}:\\`,
);

const linuxPseudoFileSystems = new Set([
  'autofs',
  'binfmt_misc',
  'bpf',
  'cgroup',
  'cgroup2',
  'configfs',
  'debugfs',
  'devpts',
  'devtmpfs',
  'efivarfs',
  'fusectl',
  'hugetlbfs',
  'mqueue',
  'nsfs',
  'overlay',
  'proc',
  'pstore',
  'ramfs',
  'rpc_pipefs',
  'securityfs',
  'selinuxfs',
  'squashfs',
  'sysfs',
  'tmpfs',
  'tracefs',
]);

const linuxMountPrefixes = ['/media/', '/run/media/', '/mnt/'];

function unescapeProcMountPath(value: string): string {
  return value.replace(/\\([0-7]{3})/g, (_, octal: string) =>
    String.fromCharCode(Number.parseInt(octal, 8)),
  );
}

async function listWindowsVolumes(deps: LocalVolumeDeps, signal?: AbortSignal): Promise<string[]> {
  throwIfAborted(signal);
  const probed = await Promise.all(
    windowsDriveLetters.map(async (drive) => {
      const info = await deps.stat(drive).catch(() => undefined);
      return info?.isDirectory() ? drive : undefined;
    }),
  );
  throwIfAborted(signal);
  return probed.filter((drive): drive is string => drive !== undefined);
}

async function listDarwinVolumes(deps: LocalVolumeDeps, signal?: AbortSignal): Promise<string[]> {
  throwIfAborted(signal);
  const entries = await deps.readdir('/Volumes', { withFileTypes: true }).catch(() => undefined);
  throwIfAborted(signal);
  if (!entries) return ['/'];

  const discovered = await Promise.all(
    entries.map(async (entry) => {
      const volumePath = posix.join('/Volumes', entry.name);
      if (entry.isSymbolicLink()) {
        const resolved = await deps.realpath(volumePath).catch(() => undefined);
        if (resolved === '/') return undefined;
      }
      const info = await deps.stat(volumePath).catch(() => undefined);
      return info?.isDirectory() ? volumePath : undefined;
    }),
  );
  throwIfAborted(signal);

  const unique = [...new Set(discovered.filter((value): value is string => value !== undefined))];
  unique.sort((a, b) => (a < b ? -1 : Number(a > b)));
  return ['/', ...unique];
}

async function listLinuxVolumes(deps: LocalVolumeDeps, signal?: AbortSignal): Promise<string[]> {
  throwIfAborted(signal);
  const content = await deps.readFile('/proc/mounts', 'utf8').catch(() => undefined);
  throwIfAborted(signal);
  if (!content) return ['/'];

  const mounts = new Set<string>();
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const fields = trimmed.split(' ');
    const rawMountPoint = fields[1];
    const fsType = fields[2];
    if (!rawMountPoint || !fsType || linuxPseudoFileSystems.has(fsType)) continue;
    const mountPoint = unescapeProcMountPath(rawMountPoint);
    if (linuxMountPrefixes.some((prefix) => mountPoint.startsWith(prefix))) {
      mounts.add(mountPoint);
    }
  }

  const sorted = [...mounts].sort((a, b) => (a < b ? -1 : Number(a > b)));
  return ['/', ...sorted];
}

export async function listLocalVolumes(
  signal?: AbortSignal,
  deps: LocalVolumeDeps = defaultLocalVolumeDeps,
): Promise<string[]> {
  throwIfAborted(signal);
  if (deps.platform === 'win32') return listWindowsVolumes(deps, signal);
  if (deps.platform === 'darwin') return listDarwinVolumes(deps, signal);
  if (deps.platform === 'linux') return listLinuxVolumes(deps, signal);
  return ['/'];
}
