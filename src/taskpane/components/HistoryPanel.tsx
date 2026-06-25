import * as React from "react";
import {
  ConversationRecord,
  deleteConversation,
  listConversations,
  renameConversation,
} from "../lib/history-store";
import type { ChatEmbedApi } from "../hooks/use-chat-embed";

/**
 * HistoryPanel (Phase 4) — local conversation navigator for the Excel add-in.
 *
 * Stateless embeds hide their own conversation sidebar, so the add-in surfaces
 * its IndexedDB history here: a left slide-in drawer (opened by a floating
 * button over the full-screen chat iframe) that lists conversations
 * newest-first and lets the user switch, start a new one, rename, delete, and
 * filter by title.
 *
 * Theming follows the task-pane shell: system colors (`Canvas` / `CanvasText` /
 * `GrayText`) adapt to Office light/dark automatically, with the Office accent
 * `#0F6CBD` as the single highlight. Destructive delete is a two-step inline
 * confirm — NOT a `window.confirm()`, which would block the WKWebView and brick
 * the postMessage bridge (host constraint).
 */

const ACCENT = "#0F6CBD";

interface HistoryPanelProps {
  api: ChatEmbedApi;
  /** Open/close the developer inspector (drawer-footer affordance). */
  onToggleInspector: () => void;
}

export function HistoryPanel({ api, onToggleInspector }: HistoryPanelProps): React.ReactElement {
  const { userId, activeConversationId, storeVersion, switchConversation, newConversation } = api;

  const [open, setOpen] = React.useState(false);
  const [conversations, setConversations] = React.useState<ConversationRecord[]>([]);
  const [search, setSearch] = React.useState("");
  const [renamingId, setRenamingId] = React.useState<string | null>(null);
  const [renameDraft, setRenameDraft] = React.useState("");
  const [pendingDeleteId, setPendingDeleteId] = React.useState<string | null>(null);
  // Local refresh tick — bumped after panel-driven rename/delete so the list
  // re-reads without waiting on an embed event. Combined with api.storeVersion.
  const [localTick, setLocalTick] = React.useState(0);

  const searchRef = React.useRef<HTMLInputElement>(null);

  // Load (and re-load) the conversation list whenever the store changes —
  // either an embed-driven write (storeVersion) or a panel-driven edit
  // (localTick) — or the signed-in user changes.
  React.useEffect(() => {
    if (!userId) {
      setConversations([]);
      return;
    }
    let cancelled = false;
    void listConversations(userId).then((rows) => {
      if (!cancelled) setConversations(rows);
    });
    return () => {
      cancelled = true;
    };
  }, [userId, storeVersion, localTick]);

  // When the drawer opens, focus search and reset transient row state.
  React.useEffect(() => {
    if (open) {
      setPendingDeleteId(null);
      setRenamingId(null);
      // Defer focus until the drawer has mounted/animated in.
      const id = window.setTimeout(() => searchRef.current?.focus(), 60);
      return () => window.clearTimeout(id);
    }
    return undefined;
  }, [open]);

  // Esc closes the drawer (unless an inline edit is capturing it).
  React.useEffect(() => {
    if (!open) return undefined;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !renamingId && !pendingDeleteId) setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, renamingId, pendingDeleteId]);

  const query = search.trim().toLowerCase();
  const visible = query
    ? conversations.filter((c) => c.title.toLowerCase().includes(query))
    : conversations;

  // --- Actions --------------------------------------------------------------

  async function handleSwitch(id: string) {
    await switchConversation(id);
    setOpen(false);
  }

  function handleNew() {
    newConversation();
    setOpen(false);
  }

  function startRename(c: ConversationRecord) {
    setPendingDeleteId(null);
    setRenamingId(c.id);
    setRenameDraft(c.title);
  }

  async function commitRename(id: string) {
    const title = renameDraft.trim();
    setRenamingId(null);
    if (userId && title) {
      await renameConversation(userId, id, title);
      setLocalTick((t) => t + 1);
    }
  }

  async function confirmDelete(id: string) {
    if (!userId) return;
    await deleteConversation(userId, id);
    setPendingDeleteId(null);
    // If we deleted the conversation on screen, reset the embed to a blank one.
    if (id === activeConversationId) newConversation();
    setLocalTick((t) => t + 1);
  }

  // --- Render ---------------------------------------------------------------

  return (
    <>
      <style>{CSS}</style>

      <div className="uxh-fab">
        <button
          type="button"
          className="uxh-toggle"
          aria-label="Open conversation history"
          aria-expanded={open}
          onClick={() => setOpen(true)}
        >
          <HistoryIcon />
          <span className="uxh-toggle-count">{conversations.length}</span>
        </button>
        <button
          type="button"
          className="uxh-fab-new"
          aria-label="Start a new chat"
          onClick={() => newConversation()}
        >
          <PlusIcon />
          New chat
        </button>
      </div>

      {open && (
        <div className="uxh-scrim" onClick={() => setOpen(false)}>
          <div
            className="uxh-drawer"
            role="dialog"
            aria-modal="true"
            aria-label="Conversation history"
            onClick={(e) => e.stopPropagation()}
          >
            <header className="uxh-head">
              <h2 className="uxh-title">History</h2>
              <button
                type="button"
                className="uxh-icon-btn"
                aria-label="Close history"
                onClick={() => setOpen(false)}
              >
                <CloseIcon />
              </button>
            </header>

            <div className="uxh-controls">
              <input
                ref={searchRef}
                type="search"
                className="uxh-search"
                placeholder="Search conversations"
                aria-label="Search conversations"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
              <button type="button" className="uxh-new" onClick={handleNew}>
                <PlusIcon />
                New conversation
              </button>
            </div>

            <ul className="uxh-list">
              {visible.length === 0 ? (
                <li className="uxh-empty">
                  {conversations.length === 0
                    ? "No conversations yet. Start chatting and they'll appear here."
                    : `No conversations match "${search.trim()}".`}
                </li>
              ) : (
                visible.map((c) => {
                  const isActive = c.id === activeConversationId;
                  const isRenaming = c.id === renamingId;
                  const isDeleting = c.id === pendingDeleteId;

                  if (isDeleting) {
                    return (
                      <li key={c.id} className="uxh-row uxh-row-confirm">
                        <span className="uxh-confirm-text">Delete this conversation?</span>
                        <span className="uxh-confirm-actions">
                          <button
                            type="button"
                            className="uxh-danger"
                            onClick={() => void confirmDelete(c.id)}
                          >
                            Delete
                          </button>
                          <button
                            type="button"
                            className="uxh-ghost"
                            onClick={() => setPendingDeleteId(null)}
                          >
                            Cancel
                          </button>
                        </span>
                      </li>
                    );
                  }

                  return (
                    <li
                      key={c.id}
                      className={`uxh-row${isActive ? " uxh-row-active" : ""}`}
                    >
                      {isRenaming ? (
                        <input
                          type="text"
                          className="uxh-rename"
                          aria-label="Conversation title"
                          autoFocus
                          value={renameDraft}
                          onChange={(e) => setRenameDraft(e.target.value)}
                          onBlur={() => void commitRename(c.id)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") void commitRename(c.id);
                            if (e.key === "Escape") setRenamingId(null);
                          }}
                        />
                      ) : (
                        <>
                          <button
                            type="button"
                            className="uxh-row-main"
                            aria-current={isActive ? "true" : undefined}
                            onClick={() => void handleSwitch(c.id)}
                          >
                            <span className="uxh-row-title">{c.title}</span>
                            <span className="uxh-row-time">{relativeTime(c.updatedAt)}</span>
                          </button>
                          <span className="uxh-actions">
                            <button
                              type="button"
                              className="uxh-icon-btn"
                              aria-label={`Rename ${c.title}`}
                              onClick={() => startRename(c)}
                            >
                              <PencilIcon />
                            </button>
                            <button
                              type="button"
                              className="uxh-icon-btn"
                              aria-label={`Delete ${c.title}`}
                              onClick={() => setPendingDeleteId(c.id)}
                            >
                              <TrashIcon />
                            </button>
                          </span>
                        </>
                      )}
                    </li>
                  );
                })
              )}
            </ul>

            <footer className="uxh-foot">
              <span className="uxh-foot-note">Stored locally on this device</span>
              <button
                type="button"
                className="uxh-foot-btn"
                onClick={onToggleInspector}
                title="Developer event inspector"
              >
                Inspector
              </button>
            </footer>
          </div>
        </div>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Compact, glanceable age of a conversation: now · 5m · 3h · 2d · Mar 4. */
function relativeTime(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "";
  const diff = Date.now() - then;
  const min = 60_000;
  const hour = 60 * min;
  const day = 24 * hour;
  if (diff < min) return "now";
  if (diff < hour) return `${Math.floor(diff / min)}m`;
  if (diff < day) return `${Math.floor(diff / hour)}h`;
  if (diff < 7 * day) return `${Math.floor(diff / day)}d`;
  return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

// Inline SVGs inherit `currentColor`, so they track the system text color and
// adapt to Office light/dark without per-icon theming.
const PencilIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M12 20h9" />
    <path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z" />
  </svg>
);
const TrashIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M3 6h18" />
    <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m3 0v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" />
  </svg>
);
const CloseIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M18 6 6 18M6 6l12 12" />
  </svg>
);
const PlusIcon = () => (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M12 5v14M5 12h14" />
  </svg>
);
const HistoryIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M3 3v5h5" />
    <path d="M3.05 13A9 9 0 1 0 6 5.3L3 8" />
    <path d="M12 7v5l4 2" />
  </svg>
);

// ---------------------------------------------------------------------------
// Styles — injected once. Inline styles can't express :hover / :focus-within /
// keyframes, so the panel ships its own scoped stylesheet (uxh- prefix). Colors
// use CSS system keywords + the Office accent so it inherits the host theme.
// ---------------------------------------------------------------------------

const CSS = `
.uxh-fab {
  position: fixed; top: 10px; left: 10px; z-index: 9000;
  display: flex; align-items: center; gap: 8px;
}
.uxh-toggle {
  display: inline-flex; align-items: center; gap: 6px;
  height: 32px; padding: 0 10px;
  font: 600 12px/1 "Segoe UI", system-ui, sans-serif;
  color: CanvasText; background: Canvas;
  border: 1px solid rgba(128,128,128,0.35); border-radius: 16px;
  box-shadow: 0 1px 4px rgba(0,0,0,0.18); cursor: pointer;
  opacity: 0.85; transition: opacity .15s, box-shadow .15s, border-color .15s;
}
.uxh-toggle:hover { opacity: 1; box-shadow: 0 2px 8px rgba(0,0,0,0.28); }
.uxh-toggle:focus-visible { outline: 2px solid ${ACCENT}; outline-offset: 2px; opacity: 1; }
.uxh-toggle-count { color: GrayText; font-weight: 400; }

.uxh-fab-new {
  display: inline-flex; align-items: center; gap: 6px;
  height: 32px; padding: 0 12px 0 10px;
  font: 600 12px/1 "Segoe UI", system-ui, sans-serif;
  color: #fff; background: ${ACCENT};
  border: 1px solid ${ACCENT}; border-radius: 16px;
  box-shadow: 0 1px 4px rgba(0,0,0,0.22); cursor: pointer;
  opacity: 0.9; transition: opacity .15s, box-shadow .15s, filter .15s;
}
.uxh-fab-new:hover { opacity: 1; filter: brightness(1.08); box-shadow: 0 2px 8px rgba(0,0,0,0.3); }
.uxh-fab-new:focus-visible { outline: 2px solid ${ACCENT}; outline-offset: 2px; opacity: 1; }

.uxh-scrim {
  position: fixed; inset: 0; z-index: 9001;
  background: rgba(0,0,0,0.32);
  animation: uxh-fade .16s ease-out;
}
.uxh-drawer {
  position: absolute; top: 0; left: 0; bottom: 0;
  width: min(360px, 86vw);
  display: flex; flex-direction: column;
  background: Canvas; color: CanvasText;
  border-right: 1px solid rgba(128,128,128,0.3);
  box-shadow: 4px 0 24px rgba(0,0,0,0.28);
  font-family: "Segoe UI", system-ui, sans-serif;
  animation: uxh-slide .2s cubic-bezier(.2,.8,.2,1);
}

.uxh-head {
  display: flex; align-items: center; justify-content: space-between;
  padding: 14px 12px 10px 16px;
}
.uxh-title { margin: 0; font-size: 15px; font-weight: 600; letter-spacing: .01em; }

.uxh-controls { padding: 0 12px 10px; display: flex; flex-direction: column; gap: 8px; }
.uxh-search {
  width: 100%; box-sizing: border-box; height: 34px; padding: 0 10px;
  font: 13px "Segoe UI", system-ui, sans-serif;
  color: CanvasText; background: rgba(128,128,128,0.08);
  border: 1px solid rgba(128,128,128,0.3); border-radius: 6px;
}
.uxh-search:focus-visible { outline: none; border-color: ${ACCENT}; box-shadow: 0 0 0 1px ${ACCENT}; }
.uxh-new {
  display: inline-flex; align-items: center; justify-content: center; gap: 7px;
  height: 36px; font: 600 13px "Segoe UI", system-ui, sans-serif;
  color: #fff; background: ${ACCENT};
  border: none; border-radius: 6px; cursor: pointer;
  transition: filter .15s;
}
.uxh-new:hover { filter: brightness(1.08); }
.uxh-new:focus-visible { outline: 2px solid ${ACCENT}; outline-offset: 2px; }

.uxh-list {
  list-style: none; margin: 0; padding: 4px 8px 8px; overflow-y: auto; flex: 1 1 auto;
}
.uxh-empty { padding: 24px 12px; color: GrayText; font-size: 13px; line-height: 1.5; text-align: center; }

.uxh-row {
  display: flex; align-items: stretch; gap: 2px;
  border-left: 3px solid transparent; border-radius: 6px;
  margin-bottom: 1px;
}
.uxh-row:hover { background: rgba(128,128,128,0.1); }
.uxh-row-active { background: rgba(15,108,189,0.12); border-left-color: ${ACCENT}; }
.uxh-row-active:hover { background: rgba(15,108,189,0.16); }

.uxh-row-main {
  flex: 1 1 auto; min-width: 0;
  display: flex; align-items: baseline; gap: 8px;
  padding: 9px 4px 9px 10px;
  background: none; border: none; cursor: pointer; text-align: left;
  font: inherit; color: CanvasText;
}
.uxh-row-main:focus-visible { outline: 2px solid ${ACCENT}; outline-offset: -2px; border-radius: 6px; }
.uxh-row-title {
  flex: 1 1 auto; min-width: 0; font-size: 13px;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.uxh-row-active .uxh-row-title { font-weight: 600; }
.uxh-row-time { flex: 0 0 auto; font-size: 11px; color: GrayText; }

.uxh-actions { display: flex; align-items: center; padding-right: 4px; opacity: 0.55; transition: opacity .12s; }
.uxh-row:hover .uxh-actions, .uxh-row:focus-within .uxh-actions, .uxh-row-active .uxh-actions { opacity: 1; }

.uxh-icon-btn {
  display: inline-flex; align-items: center; justify-content: center;
  width: 28px; height: 28px;
  color: GrayText; background: none; border: none; border-radius: 5px; cursor: pointer;
  transition: background .12s, color .12s;
}
.uxh-icon-btn:hover { background: rgba(128,128,128,0.2); color: CanvasText; }
.uxh-icon-btn:focus-visible { outline: 2px solid ${ACCENT}; outline-offset: -1px; color: CanvasText; }

.uxh-rename {
  flex: 1 1 auto; margin: 5px 4px 5px 7px; height: 30px; padding: 0 8px;
  font: 13px "Segoe UI", system-ui, sans-serif; color: CanvasText;
  background: Canvas; border: 1px solid ${ACCENT}; border-radius: 5px;
}
.uxh-rename:focus-visible { outline: none; box-shadow: 0 0 0 1px ${ACCENT}; }

.uxh-row-confirm {
  align-items: center; justify-content: space-between; gap: 8px;
  padding: 8px 8px 8px 10px; border-left-color: #c4314b;
  background: rgba(196,49,75,0.1);
}
.uxh-confirm-text { font-size: 12.5px; color: CanvasText; }
.uxh-confirm-actions { display: flex; gap: 6px; flex: 0 0 auto; }
.uxh-danger, .uxh-ghost {
  height: 28px; padding: 0 12px; font: 600 12px "Segoe UI", system-ui, sans-serif;
  border-radius: 5px; cursor: pointer;
}
.uxh-danger { color: #fff; background: #c4314b; border: none; }
.uxh-danger:hover { filter: brightness(1.08); }
.uxh-danger:focus-visible { outline: 2px solid #c4314b; outline-offset: 2px; }
.uxh-ghost { color: CanvasText; background: none; border: 1px solid rgba(128,128,128,0.4); }
.uxh-ghost:hover { background: rgba(128,128,128,0.15); }
.uxh-ghost:focus-visible { outline: 2px solid ${ACCENT}; outline-offset: 2px; }

.uxh-foot {
  flex: 0 0 auto; padding: 9px 12px 12px 16px; font-size: 12px;
  border-top: 1px solid rgba(128,128,128,0.22);
  display: flex; align-items: center; justify-content: space-between; gap: 8px;
}
.uxh-foot-note { color: CanvasText; opacity: 0.72; }
.uxh-foot-btn {
  flex: 0 0 auto;
  font: 600 12px "Segoe UI", system-ui, sans-serif; color: CanvasText;
  background: rgba(128,128,128,0.1);
  border: 1px solid rgba(128,128,128,0.42); border-radius: 6px;
  padding: 4px 12px; cursor: pointer;
  transition: background .12s, border-color .12s;
}
.uxh-foot-btn:hover { background: rgba(128,128,128,0.2); border-color: rgba(128,128,128,0.6); }
.uxh-foot-btn:focus-visible { outline: 2px solid ${ACCENT}; outline-offset: 2px; }

@keyframes uxh-fade { from { opacity: 0; } to { opacity: 1; } }
@keyframes uxh-slide { from { transform: translateX(-100%); } to { transform: translateX(0); } }
@media (prefers-reduced-motion: reduce) {
  .uxh-scrim, .uxh-drawer { animation: none; }
}
`;
