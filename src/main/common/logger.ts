export interface StructuredLogger {
  event(name: string, fields: Readonly<Record<string, string | number | boolean>>): void;
}
