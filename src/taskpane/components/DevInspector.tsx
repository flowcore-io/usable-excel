import * as React from "react";
import {
  DebugLogEntry,
  clearDebugLogs,
  getDebugLogs,
  subscribeDebugLog,
} from "../lib/debug-log";

/**
 * DevInspector — an opt-in, DevTools-style event log for the add-in.
 *
 * Mac Office task panes don't expose Inspect Element, so this surfaces the raw
 * iframe→parent message stream (tapped via the SDK's `onMessage` hook) plus the
 * store's own breadcrumbs (`store✓`, `restore→upsert`). It's hidden from normal
 * users; developers open it from the "Inspector" button in the history drawer
 * footer. The open/closed state is owned by `ChatPane` and persisted in
 * localStorage.
 *
 * Controlled component: `open` / `onClose` are supplied by the parent.
 */

const STORAGE_KEY = "usable-excel:devInspector";

/** Read the persisted open state — used by the parent to seed initial state. */
export function readInspectorOpen(): boolean {
  try {
    return window.localStorage.getItem(STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

/** Persist the open state so the inspector survives pane reloads. */
export function persistInspectorOpen(open: boolean): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, open ? "1" : "0");
  } catch {
    // localStorage may be unavailable in some WebView contexts — non-fatal.
  }
}

// Lifecycle events worth colour-coding in the stream.
const HIGHLIGHT: Record<string, string> = {
  CONVERSATION_CREATED: "#7ee787",
  MESSAGE_CREATED: "#79c0ff",
  CONVERSATION_RENAMED: "#d2a8ff",
  CONVERSATION_MESSAGES_UPSERTED: "#ffa657",
};

interface DevInspectorProps {
  open: boolean;
  onClose: () => void;
}

export function DevInspector({ open, onClose }: DevInspectorProps): React.ReactElement | null {
  const entries = React.useSyncExternalStore<DebugLogEntry[]>(subscribeDebugLog, getDebugLogs);
  const scrollRef = React.useRef<HTMLDivElement>(null);

  // Auto-scroll to newest while open.
  React.useEffect(() => {
    if (open && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [entries, open]);

  if (!open) return null;

  return (
    <div style={styles.wrap}>
      <div style={styles.header}>
        <span style={styles.title}>
          Inspector&nbsp;<span style={styles.hint}>· events</span>
        </span>
        <span style={styles.headerActions}>
          <span style={styles.count}>{entries.length}</span>
          <button style={styles.btn} onClick={() => clearDebugLogs()}>
            clear
          </button>
          <button style={styles.btn} onClick={onClose} aria-label="Close inspector">
            close
          </button>
        </span>
      </div>

      <div ref={scrollRef} style={styles.body}>
        {entries.length === 0 ? (
          <div style={styles.empty}>No events yet — interact with the chat to capture activity.</div>
        ) : (
          entries.map((e) => (
            <div key={e.id} style={styles.row}>
              <span style={styles.ts}>{e.ts}</span>
              <span
                style={{
                  ...styles.type,
                  color: HIGHLIGHT[e.type] ?? "#c9d1d9",
                  fontWeight: HIGHLIGHT[e.type] ? 700 : 400,
                }}
              >
                {e.type}
              </span>
              <span style={styles.detail}>{e.detail}</span>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

const MONO = 'ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace';

const styles = {
  wrap: {
    position: "fixed" as const,
    left: 0,
    right: 0,
    bottom: 0,
    zIndex: 2147483647,
    background: "rgba(13,17,23,0.96)",
    color: "#c9d1d9",
    fontFamily: MONO,
    fontSize: 11,
    borderTop: "1px solid #30363d",
    boxShadow: "0 -4px 12px rgba(0,0,0,0.4)",
    maxHeight: "45vh",
    display: "flex" as const,
    flexDirection: "column" as const,
  },
  header: {
    display: "flex" as const,
    alignItems: "center" as const,
    justifyContent: "space-between" as const,
    padding: "4px 8px",
    background: "#161b22",
    borderBottom: "1px solid #30363d",
    flex: "0 0 auto" as const,
  },
  title: { fontWeight: 600 as const },
  hint: { color: "#8b949e", fontWeight: 400 as const },
  headerActions: {
    display: "flex" as const,
    alignItems: "center" as const,
    gap: 6,
  },
  count: { color: "#8b949e" },
  btn: {
    background: "#21262d",
    color: "#c9d1d9",
    border: "1px solid #30363d",
    borderRadius: 4,
    fontSize: 10,
    padding: "2px 6px",
    cursor: "pointer" as const,
    fontFamily: MONO,
  },
  body: {
    overflowY: "auto" as const,
    padding: "4px 8px",
    flex: "1 1 auto" as const,
  },
  empty: { color: "#8b949e", padding: "8px 0" },
  row: {
    display: "flex" as const,
    gap: 8,
    padding: "2px 0",
    borderBottom: "1px solid rgba(48,54,61,0.4)",
    alignItems: "baseline" as const,
  },
  ts: { color: "#6e7681", flex: "0 0 auto" as const },
  type: { flex: "0 0 auto" as const },
  detail: {
    color: "#8b949e",
    wordBreak: "break-all" as const,
    whiteSpace: "pre-wrap" as const,
  },
} as const;
