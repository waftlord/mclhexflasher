export type LogLevel = 'info' | 'success' | 'warn' | 'error' | 'debug';

export interface LogEntry {
  id: number;
  level: LogLevel;
  message: string;
  time: string;
}

export type LogSink = (level: LogLevel, message: string) => void;

export function createLogEntry(id: number, level: LogLevel, message: string): LogEntry {
  return {
    id,
    level,
    message,
    time: new Date().toLocaleTimeString(),
  };
}

export function logEntriesToText(entries: LogEntry[]): string {
  return entries.map((entry) => `[${entry.time}] ${entry.level.toUpperCase()} ${entry.message}`).join('\n');
}

export function downloadTextFile(filename: string, contents: string): void {
  const blob = new Blob([contents], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.style.display = 'none';
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}
