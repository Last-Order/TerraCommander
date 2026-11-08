import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);

export async function listLocalVolumes(signal?: AbortSignal): Promise<string[]> {
  if (process.platform !== 'win32') return ['/'];

  const executable = join(
    process.env.SystemRoot ?? 'C:\\Windows',
    'System32',
    'WindowsPowerShell',
    'v1.0',
    'powershell.exe',
  );
  const { stdout } = await exec(
    executable,
    ['-NoProfile', '-NonInteractive', '-Command', '[IO.DriveInfo]::GetDrives().Name'],
    { windowsHide: true, timeout: 10_000, signal },
  );
  return stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /^[A-Z]:\\$/i.test(line));
}
