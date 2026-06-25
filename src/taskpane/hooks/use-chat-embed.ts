import { RefObject, useCallback, useEffect, useRef, useState } from "react";
import { UsableChatEmbed } from "../lib/embed-sdk";
import { excelToolSchemas, handleExcelToolCall } from "../lib/excel-tools";
import { pushDebugLog } from "../lib/debug-log"; // feeds the dev inspector
import {
  appendMessage,
  getCounts,
  getLastActive,
  loadConversation,
  renameConversation,
  setLastActive,
  upsertConversation,
} from "../lib/history-store";

/**
 * Imperative + reactive surface returned by {@link useChatEmbed}. The history
 * panel (Phase 4) drives the embed through this instead of touching the embed
 * instance directly.
 */
export interface ChatEmbedApi {
  /** JWT `sub` of the signed-in user — scopes every local-history read. */
  userId: string | null;
  /** Conversation currently shown in the embed (for list highlighting). */
  activeConversationId: string | null;
  /** Bumps whenever the embed writes to the local store (create/message/rename),
   *  so the panel can re-read the conversation list without manual refresh. */
  storeVersion: number;
  /** Re-hydrate the embed with a stored conversation (reuses the Phase 3 path). */
  switchConversation: (conversationId: string) => Promise<void>;
  /** Start a fresh conversation in the embed and clear the restore pointer. */
  newConversation: () => void;
}

/**
 * Re-hydrate the embed's transcript from a locally-stored conversation. Shared
 * by restore-on-load (`onReady`, Phase 3) and the panel's switch action
 * (Phase 4): a `replace-all` upsert swaps the whole transcript and the embed
 * adopts the conversation id, so subsequent turns continue it (continuity
 * verified in Phase 3, solution `9e5e358a`).
 */
async function restoreConversationIntoEmbed(
  embed: UsableChatEmbed,
  conversationId: string
): Promise<void> {
  const { messages } = await loadConversation(conversationId);
  pushDebugLog("restore→upsert", { conversationId, count: messages.length });
  embed.upsertConversationMessages({
    conversationId,
    messages: messages.map((m) => m.message), // raw ExportedMessage[]
    mode: "replace-all",
  });
}

/**
 * Decode the `sub` (user id) claim from a JWT without verifying it — used only
 * to scope local history per user, never for trust decisions. Returns null on
 * any malformed token.
 */
function getUserIdFromToken(token: string | null): string | null {
  if (!token) return null;
  try {
    const payload = token.split(".")[1];
    if (!payload) return null;
    const b64 = payload.replace(/-/g, "+").replace(/_/g, "/");
    const padded = b64 + "===".slice((b64.length + 3) % 4);
    const data = JSON.parse(atob(padded));
    return typeof data.sub === "string" ? data.sub : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

// Public embed token — configures which Usable workspace/expert is shown.
// Override via Office.context.roamingSettings key "embedTokenOverride".
const DEFAULT_EMBED_TOKEN = "uc_9aa8469f94a1a1065e4210218013e171775c319652d283f8b120df23e7fc3e22";

const IFRAME_ORIGIN = "https://chat.usable.dev";

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

/**
 * @param iframeRef        - Ref to the chat iframe element.
 * @param accessToken      - Keycloak JWT to authenticate the embed. Pass null when unauthenticated.
 * @param ensureValidToken - Returns current token if fresh (>60s), otherwise refreshes.
 */
export function useChatEmbed(
  iframeRef: RefObject<HTMLIFrameElement>,
  accessToken: string | null,
  ensureValidToken: () => Promise<string | null>
): ChatEmbedApi {
  const embedRef = useRef<UsableChatEmbed | null>(null);

  // Ref so the onReady closure always sees the latest token without re-creating the embed.
  const accessTokenRef = useRef<string | null>(accessToken);
  accessTokenRef.current = accessToken;

  // Current user id (JWT sub) for scoping local history. Kept in a ref so the
  // persistence callbacks (created once with the embed) always read the latest
  // value across token refreshes. The sub is stable across refreshes.
  const userId = getUserIdFromToken(accessToken);
  const userIdRef = useRef<string | null>(userId);
  userIdRef.current = userId;

  // Reactive surface for the history panel (Phase 4).
  // - activeConversationId: which conversation the embed is showing (highlight).
  // - storeVersion: bumped on every embed-driven store write so the panel
  //   re-reads the list (new conversation / new message / rename).
  const [activeConversationId, setActiveConversationId] = useState<string | null>(null);
  const [storeVersion, setStoreVersion] = useState(0);
  const bumpStoreVersion = useCallback(() => setStoreVersion((v) => v + 1), []);

  // -------------------------------------------------------------------------
  // Create / destroy the embed instance when the iframe mounts
  // -------------------------------------------------------------------------

  useEffect(() => {
    const iframe = iframeRef.current;
    if (!iframe) return;

    // Read embed token override from roaming settings (if set by the user)
    let embedToken = DEFAULT_EMBED_TOKEN;
    try {
      const override = Office.context.roamingSettings.get("embedTokenOverride") as string | null;
      if (override) embedToken = override;
    } catch {
      // roamingSettings may not be available in all contexts
    }

    // Set the iframe src
    const targetSrc = `${IFRAME_ORIGIN}/embed?token=${encodeURIComponent(embedToken)}`;
    if (iframe.src !== targetSrc) {
      iframe.src = targetSrc;
    }

    // Create the embed SDK instance
    const embed = new UsableChatEmbed(iframe, {
      iframeOrigin: IFRAME_ORIGIN,

      // Feed the dev inspector (opened with Ctrl/⌘+Shift+D) with the raw stream.
      onMessage: (type, payload) => pushDebugLog(type, payload),

      onToolCall: async (tool, args, _requestId) => {
        return handleExcelToolCall(tool, args);
      },

      onTokenRefreshRequired: ensureValidToken,

      onError: (code, message) => {
        console.error(`[UsableEmbed] Error ${code}: ${message}`);
      },

      // Keep the panel's active-row highlight in sync with whatever the embed
      // currently shows (fires after restore and when a new conversation gets
      // its id on the first turn).
      onConversationChange: (conversationId) => {
        setActiveConversationId(conversationId);
      },

      // Phase 2 — capture chat into the local IndexedDB history store.
      // Writes are idempotent (put-by-id on message.id) and scoped by userId,
      // and guarded until the user id is known. The pushDebugLog lines remain
      // as on-screen verification (insert/update + row counts) since the Office
      // pane has no easy DevTools.
      onConversationCreated: (p) => {
        pushDebugLog("cb:CONVERSATION_CREATED", p);
        const userId = userIdRef.current;
        if (!userId) return;
        void upsertConversation({
          id: p.conversationId,
          userId,
          title: p.title,
          createdAt: p.createdAt,
          updatedAt: p.updatedAt,
        }).then(bumpStoreVersion);
      },
      onMessageCreated: (p) => {
        pushDebugLog("cb:MESSAGE_CREATED", p);
        const userId = userIdRef.current;
        if (!userId) return;
        void (async () => {
          const { inserted } = await appendMessage({
            userId,
            conversationId: p.conversationId,
            kind: p.kind,
            message: p.message,
          });
          await setLastActive(userId, p.conversationId);
          const counts = await getCounts(userId);
          pushDebugLog("store✓", { wrote: inserted ? "insert" : "update(dedup)", ...counts });
          bumpStoreVersion();
        })();
      },
      onConversationRenamed: (p) => {
        pushDebugLog("cb:CONVERSATION_RENAMED", p);
        const userId = userIdRef.current;
        if (!userId) return;
        void renameConversation(userId, p.conversationId, p.title ?? "Embed Session").then(
          bumpStoreVersion
        );
      },
      // Phase 3 — ack for a parent-driven restore (UPSERT_CONVERSATION_MESSAGES).
      // Gate on p.ok: on failure, surface it (the transcript silently stayed
      // empty otherwise). On success, reassert lastActive to whatever id the
      // embed reports — this keeps our pointer aligned if the embed adopts or
      // re-mints the conversation id during hydration (the continuity crux).
      onConversationMessagesUpserted: (p) => {
        pushDebugLog("cb:MESSAGES_UPSERTED", p);
        if (!p.ok) {
          console.error(`[UsableEmbed] Restore failed: ${p.error ?? "unknown error"}`);
          return;
        }
        const userId = userIdRef.current;
        if (userId && p.conversationId) {
          void setLastActive(userId, p.conversationId);
        }
      },
    });

    embedRef.current = embed;

    // On READY: register tools AND send the current auth token.
    // Auth must be sent here (not earlier) — postMessages sent before READY are
    // lost because the iframe hasn't set up its listener yet.
    embed.onReady(() => {
      embed.registerTools(excelToolSchemas);
      if (accessTokenRef.current) {
        embed.setAuth(accessTokenRef.current);
      }

      // Phase 3 — restore the user's last conversation from local history.
      // Runs after setAuth and only once the iframe is READY (postMessages sent
      // before READY are dropped). Mode "replace-all" makes a duplicate run
      // (StrictMode double-mount) harmless. No-op on a fresh start (AC4).
      const userId = userIdRef.current;
      if (userId) {
        void (async () => {
          const lastId = await getLastActive(userId);
          if (!lastId) return; // AC4 — nothing to restore, fresh start
          await restoreConversationIntoEmbed(embed, lastId);
        })();
      }
    });

    return () => {
      embed.destroy();
      embedRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [iframeRef]);

  // -------------------------------------------------------------------------
  // Re-send auth whenever the token changes after READY (silent refresh, etc.)
  // -------------------------------------------------------------------------

  useEffect(() => {
    if (accessToken && embedRef.current) {
      // Validate freshness before pushing token to the embed.
      // If the proactive timer fired late (WebView throttling), this
      // will detect near-expiry and fetch a fresh token first.
      ensureValidToken().then((validToken) => {
        if (validToken && embedRef.current) {
          embedRef.current.setAuth(validToken);
        }
      });
    }
  }, [accessToken, ensureValidToken]);

  // -------------------------------------------------------------------------
  // Imperative API for the history panel (Phase 4)
  // -------------------------------------------------------------------------

  const switchConversation = useCallback(async (conversationId: string) => {
    const embed = embedRef.current;
    const uid = userIdRef.current;
    if (!embed || !uid) return;
    // Optimistic highlight; the embed confirms via CONVERSATION_CHANGED.
    setActiveConversationId(conversationId);
    await restoreConversationIntoEmbed(embed, conversationId);
    await setLastActive(uid, conversationId);
  }, []);

  const newConversation = useCallback(() => {
    const embed = embedRef.current;
    if (!embed) return;
    embed.newConversation();
    setActiveConversationId(null);
    // Clear the restore pointer now; the first turn re-sets it via onMessageCreated.
    const uid = userIdRef.current;
    if (uid) void setLastActive(uid, null);
  }, []);

  return { userId, activeConversationId, storeVersion, switchConversation, newConversation };
}
