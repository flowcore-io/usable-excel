import { RefObject, useEffect, useRef } from "react";
import { UsableChatEmbed } from "../lib/embed-sdk";
import { excelToolSchemas, handleExcelToolCall } from "../lib/excel-tools";
import { pushDebugLog } from "../lib/debug-log"; // TEMP [Phase 0]
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
): void {
  const embedRef = useRef<UsableChatEmbed | null>(null);

  // Ref so the onReady closure always sees the latest token without re-creating the embed.
  const accessTokenRef = useRef<string | null>(accessToken);
  accessTokenRef.current = accessToken;

  // Current user id (JWT sub) for scoping local history. Kept in a ref so the
  // persistence callbacks (created once with the embed) always read the latest
  // value across token refreshes. The sub is stable across refreshes.
  const userIdRef = useRef<string | null>(getUserIdFromToken(accessToken));
  userIdRef.current = getUserIdFromToken(accessToken);

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

      // TEMP [Phase 0] — feed the on-screen debug console.
      onMessage: (type, payload) => pushDebugLog(type, payload),

      onToolCall: async (tool, args, _requestId) => {
        return handleExcelToolCall(tool, args);
      },

      onTokenRefreshRequired: ensureValidToken,

      onError: (code, message) => {
        console.error(`[UsableEmbed] Error ${code}: ${message}`);
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
        });
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
        })();
      },
      onConversationRenamed: (p) => {
        pushDebugLog("cb:CONVERSATION_RENAMED", p);
        const userId = userIdRef.current;
        if (!userId) return;
        void renameConversation(userId, p.conversationId, p.title ?? "Embed Session");
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
          const { messages } = await loadConversation(lastId);
          if (!messages.length) return;
          pushDebugLog("restore→upsert", { conversationId: lastId, count: messages.length });
          embed.upsertConversationMessages({
            conversationId: lastId,
            messages: messages.map((m) => m.message), // raw ExportedMessage[]
            mode: "replace-all",
          });
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
}
