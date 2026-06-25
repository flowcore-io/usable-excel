import * as React from "react";
import {
  DebugLogEntry,
  clearDebugLogs,
  getDebugLogs,
  subscribeDebugLog,
} from "../lib/debug-log";

/**
 * TEMP [Phase 0 verification] — on-screen console overlay.
 *
 * Mac Office add-ins don't expose Inspect Element on the parent task pane, so
 * this renders the raw iframe→parent message stream (tapped via the SDK's
 * onMessage hook) directly in the pane. Lets us confirm the stateless embed
 * emits CONVERSATION_CREATED / MESSAGE_CREATED to our origin.
 *
 * Remove once Phase 0 is verified (or fold into a real diagnostics surface).
 */

// Highlight the lifecycle events Phase 0 is gating on.
const HIGHLIGHT: Record<string, string> = {
  CONVERSATION_CREATED: "#7ee787",
  MESSAGE_CREATED: "#79c0ff",
  CONVERSATION_RENAMED: "#d2a8ff",
  CONVERSATION_MESSAGES_UPSERTED: "#ffa657",
};

export function DebugConsole(): React.ReactElement {
  const entries = React.useSyncExternalStore<DebugLogEntry[]>(
    subscribeDebugLog,
    getDebugLogs
  );
  const [open, setOpen] = React.useState(true);
  const scrollRef = React.useRef<HTMLDivElement>(null);

  // Auto-scroll to newest.
  React.useEffect(() => {
    if (open && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [entries, open]);

  const seenTypes = new Set(entries.map((e) => e.type));
  const gatePassed =
    seenTypes.has("CONVERSATION_CREATED") && seenTypes.has("MESSAGE_CREATED");

  return (
    <div style={styles.wrap}>
      <div style={styles.header}>
        <span style={styles.title}>
          [Phase 0] rx events&nbsp;
          <span style={{ color: gatePassed ? "#7ee787" : "#ffa657" }}>
            {gatePassed ? "✓ lifecycle events seen" : "waiting…"}
          </span>
        </span>
        <span style={styles.headerActions}>
          <span style={styles.count}>{entries.length}</span>
          <button style={styles.btn} onClick={() => clearDebugLogs()}>
            clear
          </button>
          <button style={styles.btn} onClick={() => setOpen((o) => !o)}>
            {open ? "hide" : "show"}
          </button>
        </span>
      </div>

      {open && (
        <div ref={scrollRef} style={styles.body}>
          {entries.length === 0 ? (
            <div style={styles.empty}>
              No messages yet — send a chat message to capture events.
            </div>
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
      )}
    </div>
  );
}

const MONO =
  'ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace';

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
