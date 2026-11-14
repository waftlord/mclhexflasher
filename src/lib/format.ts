export function formatHexByte(value: number): string {
  return `0x${value.toString(16).padStart(2, '0').toUpperCase()}`;
}

export function formatHexAddress(value: number): string {
  return `0x${value.toString(16).padStart(6, '0').toUpperCase()}`;
}

export function formatUsbId(value?: number): string {
  if (typeof value !== 'number') return 'unknown';
  return `0x${value.toString(16).padStart(4, '0').toUpperCase()}`;
}

export function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / 1024 / 1024).toFixed(2)} MB`;
}

export function percent(done: number, total: number): number {
  if (total <= 0) return 0;
  return Math.max(0, Math.min(100, Math.round((done / total) * 100)));
}
