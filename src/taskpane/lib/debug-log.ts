/**
 * Tiny in-memory, subscribable log store that backs the {@link DevInspector}
 * (an opt-in, DevTools-style event log). Mac Office task panes don't expose
 * Inspect Element, so the add-in keeps its own event stream here and renders it
 * on demand for developers.
 */

export interface DebugLogEntry {
  id: number;
  ts: string; // HH:MM:SS.mmm
  type: string;
  detail: string;
}

const MAX_ENTRIES = 200;
let entries: DebugLogEntry[] = [];
let seq = 0;
const listeners = new Set<() => void>();

export function pushDebugLog(type: string, payload: unknown): void {
  const now = new Date();
  const ts =
    now.toTimeString().slice(0, 8) +
    "." +
    String(now.getMilliseconds()).padStart(3, "0");

  let detail = "";
  try {
    detail = payload === undefined ? "" : JSON.stringify(payload);
  } catch {
    detail = String(payload);
  }
  if (detail.length > 500) detail = detail.slice(0, 500) + "…";

  // New array reference each push so useSyncExternalStore detects the change.
  entries = [...entries, { id: ++seq, ts, type, detail }].slice(-MAX_ENTRIES);
  listeners.forEach((l) => l());
}

export function getDebugLogs(): DebugLogEntry[] {
  return entries;
}

export function clearDebugLogs(): void {
  entries = [];
  listeners.forEach((l) => l());
}

export function subscribeDebugLog(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
