export function isTrustedRenderer(candidate: string, entryUrl: string): boolean {
  try {
    const target = new URL(candidate);
    const entry = new URL(entryUrl);
    return (
      target.protocol === entry.protocol &&
      target.host === entry.host &&
      target.pathname === entry.pathname &&
      target.username === '' &&
      target.password === ''
    );
  } catch {
    return false;
  }
}
