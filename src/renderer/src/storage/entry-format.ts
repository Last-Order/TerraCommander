const sizeUnits = ['B', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB'];

export function formatSize(bytes: number, formatter: Intl.NumberFormat): string {
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < sizeUnits.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${formatter.format(value)} ${sizeUnits[unit]}`;
}
