import * as React from "react";
import { useAuth } from "./hooks/use-auth";
import { useChatEmbed } from "./hooks/use-chat-embed";
import { HistoryPanel } from "./components/HistoryPanel";
import { DevInspector, persistInspectorOpen, readInspectorOpen } from "./components/DevInspector";
import logoUrl from "../../assets/logo.png";

// ---------------------------------------------------------------------------
// ChatPane — only mounted when authenticated
// ---------------------------------------------------------------------------

interface ChatPaneProps {
  accessToken: string;
  ensureValidToken: () => Promise<string | null>;
}

function ChatPane({ accessToken, ensureValidToken }: ChatPaneProps): React.ReactElement {
  const iframeRef = React.useRef<HTMLIFrameElement>(null);
  const chatApi = useChatEmbed(iframeRef, accessToken, ensureValidToken);

  // Dev inspector open-state lives here so the history-drawer footer button
  // drives the same (persisted) state the inspector renders from. (No keyboard
  // shortcut: it's only reachable with the drawer open, where the button is.)
  const [inspectorOpen, setInspectorOpen] = React.useState(readInspectorOpen);
  const toggleInspector = React.useCallback(() => {
    setInspectorOpen((prev) => {
      const next = !prev;
      persistInspectorOpen(next);
      return next;
    });
  }, []);

  return (
    <>
      <iframe
        ref={iframeRef}
        src="about:blank"
        title="Usable Chat"
        style={styles.iframe}
        allow="clipboard-read; clipboard-write"
      />
      {/* Phase 4 — local conversation history (list / switch / new / rename / delete / search) */}
      <HistoryPanel api={chatApi} onToggleInspector={toggleInspector} />
      {/* Dev inspector — hidden; opened from the drawer footer button */}
      <DevInspector open={inspectorOpen} onClose={() => toggleInspector()} />
    </>
  );
}

// ---------------------------------------------------------------------------
// App — auth state machine
// ---------------------------------------------------------------------------

/**
 * States:
 *  "restoring"      — trying to resume a cached session (silent token refresh)
 *  "unauthenticated"— no session; show Sign-in button
 *  "authenticated"  — session active; mount ChatPane
 */
export function App(): React.ReactElement {
  const { state, accessToken, login, ensureValidToken } = useAuth();

  if (state === "restoring") {
    return (
      <div style={styles.center}>
        <div style={styles.spinner} />
        <p style={styles.label}>Signing in…</p>
      </div>
    );
  }

  if (state === "unauthenticated") {
    return (
      <div style={styles.center}>
        <img src={logoUrl} alt="Usable" style={styles.logo} />
        <p style={styles.heading}>Excel Assistant</p>
        <p style={styles.label}>Sign in to start chatting with your workbook.</p>
        <button onClick={login} style={styles.button}>
          Sign in
        </button>
      </div>
    );
  }

  // state === "authenticated"
  return (
    <ChatPane
      accessToken={accessToken!}
      ensureValidToken={ensureValidToken}
    />
  );
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

const styles = {
  center: {
    display:        "flex" as const,
    flexDirection:  "column" as const,
    alignItems:     "center" as const,
    justifyContent: "center" as const,
    height:         "100vh",
    fontFamily:     '"Segoe UI", system-ui, sans-serif',
    gap:            8,
    padding:        "0 24px",
    boxSizing:      "border-box" as const,
    textAlign:      "center" as const,
    // System colors adapt automatically to Office light/dark theme
    background:     "Canvas",
    color:          "CanvasText",
  },
  logo: {
    width:        96,
    height:       96,
    marginBottom: 8,
  },
  spinner: {
    width:          28,
    height:         28,
    border:         "3px solid rgba(128,128,128,0.35)",
    borderTopColor: "#0F6CBD",
    borderRadius:   "50%",
    animation:      "spin 0.8s linear infinite",
    marginBottom:   8,
  },
  heading: {
    margin:     0,
    fontSize:   16,
    fontWeight: 600 as const,
    color:      "CanvasText",
  },
  label: {
    margin:   0,
    fontSize: 13,
    color:    "GrayText",
  },
  button: {
    marginTop:    12,
    padding:      "8px 24px",
    background:   "#0F6CBD",
    color:        "#fff",
    border:       "none",
    borderRadius: 4,
    cursor:       "pointer" as const,
    fontSize:     14,
    fontFamily:   "inherit",
  },
  iframe: {
    position: "fixed" as const,
    top:      0,
    left:     0,
    width:    "100%",
    height:   "100%",
    border:   "none",
    display:  "block",
  },
} as const;
