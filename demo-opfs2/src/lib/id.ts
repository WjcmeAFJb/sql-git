export function genId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.floor(Math.random() * 1296)
    .toString(36)
    .padStart(2, "0")}`;
}

export function nowTs(): string {
  return new Date().toISOString();
}
