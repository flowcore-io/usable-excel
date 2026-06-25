/**
 * TEMP [Phase 0 verification] — tiny in-memory log store so we can render an
 * on-screen console in the task pane and confirm the stateless embed emits
 * CONVERSATION_CREATED / MESSAGE_CREATED to our origin (Mac Office add-ins
 * don't expose Inspect Element on the parent pane).
 *
 * Remove (or fold into a real diagnostics surface) once Phase 0 is verified.
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
