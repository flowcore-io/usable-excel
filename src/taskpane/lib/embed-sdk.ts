/**
 * UsableChatEmbed — PostMessage bridge between a host page and the embedded
 * Usable Chat iframe.
 *
 * HOST-AGNOSTIC by design: this file must NOT import anything Excel/Office
 * specific. The planned `@usable/office-embed` package (ticket
 * `eb582b42`) lifts this file verbatim, so keep all host wiring in the
 * consuming hook, not here.
 *
 * Aligned to the Usable Chat embed contract (knowledge fragment `0adf3171`,
 * v1.162.0) and extended with the stateless parent-persistence surface
 * (solution fragment `c776f8b1`):
 *   iframe→parent: CONVERSATION_CREATED, MESSAGE_CREATED, CONVERSATION_RENAMED,
 *                  CONVERSATION_MESSAGES_UPSERTED
 *   parent→iframe: UPSERT_CONVERSATION_MESSAGES
 *
 * Design notes:
 * - Single window message listener per instance; the bound handler is stored
 *   so `destroy()` can remove it (the integration-guide SDK omits this and
 *   leaks a listener per mount — see `af132e37` WKWebView double-listener).
 * - Strict origin + source validation; lifecycle events never accept `*`.
 * - Request deduplication via Set<string> to survive double-mounts / the
 *   doubled startup events observed in Phase 0.
 * - Auth token cached so it can be re-sent on REQUEST_TOKEN_REFRESH.
 */

// ---------------------------------------------------------------------------
// Stateless parent-persistence payload types (contract v1.161.0)
// ---------------------------------------------------------------------------

export type ConversationMessagesUpsertMode = "append-or-replace-by-id" | "replace-all";

/**
 * A message as exported/restored by the embed. Intentionally permissive: `parts`
 * (tool-invocation state, args/input, output), `attachments`, and any other
 * JSON-safe fields are preserved verbatim so a restored message can round-trip
 * back into tool-aware history. Do NOT narrow this — losing fields breaks restore.
 */
export interface ExportedMessage {
  id: string;
  role: "user" | "assistant" | "system";
  content?: string;
  parts?: unknown[];
  attachments?: unknown[];
  createdAt?: string;
  [key: string]: unknown;
}

export interface StatelessConversationPayload {
  conversationId: string;
  title?: string;
  stateless: true;
  createdAt?: string;
  updatedAt?: string;
}

export interface StatelessMessageCreatedPayload {
  conversationId: string;
  kind: "user" | "assistant";
  message: ExportedMessage;
}

export interface ConversationRenamedPayload {
  conversationId: string;
  title?: string;
}

export interface ConversationMessagesUpsertPayload {
  conversationId?: string | null;
  messages: ExportedMessage[];
  mode?: ConversationMessagesUpsertMode;
}

export interface ConversationMessagesUpsertedPayload {
  ok: boolean;
  conversationId?: string | null;
  messageCount?: number;
  mode?: ConversationMessagesUpsertMode;
  error?: string;
}

// ---------------------------------------------------------------------------
// Tool types
// ---------------------------------------------------------------------------

export interface ParentToolSchema {
  name: string;
  description: string;
  parameters?: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
  };
}

export interface ToolCallPayload {
  requestId: string;
  tool: string;
  args: unknown;
}

export type ToolCallHandler = (
  tool: string,
  args: unknown,
  requestId: string
) => Promise<unknown>;

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface UsableChatEmbedOptions {
  /** Expected origin of the iframe (e.g. "https://chat.usable.dev"). Use "*" to skip validation (never in prod). */
  iframeOrigin?: string;
  onToolCall?: ToolCallHandler;
  onError?: (code: string, message: string) => void;
  onConversationChange?: (conversationId: string | null) => void;
  /** Called when the embed requests a fresh token. Return the new access token, or null on failure. */
  onTokenRefreshRequired?: () => Promise<string | null>;

  // --- Stateless parent-persistence callbacks (fragment c776f8b1) ---
  /** A new stateless conversation/session was created (fires on first user turn). */
  onConversationCreated?: (payload: StatelessConversationPayload) => void;
  /** A user or assistant message was created in the stateless conversation. */
  onMessageCreated?: (payload: StatelessMessageCreatedPayload) => void;
  /** The stateless conversation title changed (title-sync). */
  onConversationRenamed?: (payload: ConversationRenamedPayload) => void;
  /** Acknowledgement of a parent-driven `upsertConversationMessages` restore. */
  onConversationMessagesUpserted?: (payload: ConversationMessagesUpsertedPayload) => void;

  /**
   * Raw tap on every validated iframe→parent message (after origin/source
   * checks, before dispatch). Feeds the host's opt-in dev inspector.
   */
  onMessage?: (type: string, payload: unknown) => void;
}

export class UsableChatEmbed {
  private iframe: HTMLIFrameElement;
  private iframeOrigin: string;
  private options: UsableChatEmbedOptions;
  private readyCallbacks: Array<() => void> = [];
  private isReady = false;
  private cachedToken: string | null = null;
  private handledRequestIds = new Set<string>();
  private messageListener: (event: MessageEvent) => void;

  constructor(iframe: HTMLIFrameElement, options: UsableChatEmbedOptions = {}) {
    this.iframe = iframe;
    this.iframeOrigin = options.iframeOrigin ?? "*";
    this.options = options;

    this.messageListener = this.handleMessage.bind(this);
    window.addEventListener("message", this.messageListener);
  }

  // ---------------------------------------------------------------------------
  // Callbacks
  // ---------------------------------------------------------------------------

  onReady(callback: () => void): void {
    if (this.isReady) {
      callback();
    } else {
      this.readyCallbacks.push(callback);
    }
  }

  // ---------------------------------------------------------------------------
  // Commands (parent → iframe)
  // ---------------------------------------------------------------------------

  setAuth(token: string): void {
    this.cachedToken = token;
    this.postToIframe({ type: "AUTH", payload: { token } });
  }

  registerTools(tools: ParentToolSchema[]): void {
    this.postToIframe({ type: "REGISTER_TOOLS", payload: { tools } });
  }

  setConfig(config: unknown): void {
    this.postToIframe({ type: "CONFIG", payload: config });
  }

  toggle(visible: boolean): void {
    this.postToIframe({ type: "TOGGLE_VISIBILITY", payload: { visible } });
  }

  newConversation(): void {
    this.postToIframe({ type: "NEW_CONVERSATION" });
  }

  restoreConversation(conversationId: string): void {
    this.postToIframe({ type: "RESTORE_CONVERSATION", payload: { conversationId } });
  }

  /**
   * Restore parent-persisted stateless messages into the iframe's local
   * transcript. Default mode `append-or-replace-by-id` for incremental
   * hydration; pass `replace-all` for a full restore-on-load (Phase 3).
   * Resolution is observed via the `onConversationMessagesUpserted` callback
   * (CONVERSATION_MESSAGES_UPSERTED ack).
   */
  upsertConversationMessages(payload: ConversationMessagesUpsertPayload): void {
    this.postToIframe({
      type: "UPSERT_CONVERSATION_MESSAGES",
      payload: {
        conversationId: payload.conversationId ?? null,
        messages: payload.messages,
        mode: payload.mode ?? "append-or-replace-by-id",
      },
    });
  }

  respondToToolCall(requestId: string, result: unknown): void {
    this.postToIframe({
      type: "TOOL_RESPONSE",
      payload: { requestId, result },
    });
  }

  destroy(): void {
    window.removeEventListener("message", this.messageListener);
  }

  // ---------------------------------------------------------------------------
  // Incoming message handler
  // ---------------------------------------------------------------------------

  private handleMessage(event: MessageEvent): void {
    // Origin validation
    if (this.iframeOrigin !== "*" && event.origin !== this.iframeOrigin) {
      return;
    }
    // Source validation — only accept messages from our iframe
    if (event.source !== this.iframe.contentWindow) {
      return;
    }

    const data = event.data;
    if (!data || typeof data !== "object" || !data.type) {
      return;
    }

    // Surface every validated iframe→parent message to the host: console for
    // normal debugging, and the optional `onMessage` tap that feeds the dev
    // inspector (Office task panes have no Inspect Element on Mac).
    console.debug("[UsableEmbed][rx]", data.type, data.payload ?? data);
    this.options.onMessage?.(data.type, data.payload ?? data);

    switch (data.type) {
      // Both READY and EMBED_READY signal readiness; fire callbacks once.
      case "READY":
      case "EMBED_READY":
        if (!this.isReady) {
          this.isReady = true;
          this.readyCallbacks.forEach((cb) => cb());
          this.readyCallbacks = [];
        }
        break;

      case "TOOL_CALL": {
        const payload = data.payload as ToolCallPayload;
        const { requestId, tool, args } = payload;

        // Deduplication — survives double-mounts / duplicated events.
        if (this.handledRequestIds.has(requestId)) {
          return;
        }
        this.handledRequestIds.add(requestId);

        if (this.options.onToolCall) {
          this.options.onToolCall(tool, args, requestId)
            .then((result) => {
              this.respondToToolCall(requestId, { success: true, result });
            })
            .catch((err: Error) => {
              this.respondToToolCall(requestId, {
                success: false,
                error: err.message ?? String(err),
              });
            })
            .finally(() => {
              // Clean up after 30 s to avoid unbounded set growth
              setTimeout(() => this.handledRequestIds.delete(requestId), 30000);
            });
        }
        break;
      }

      case "REQUEST_TOKEN_REFRESH":
        if (this.options.onTokenRefreshRequired) {
          this.options.onTokenRefreshRequired().then((token) => {
            if (token) this.setAuth(token);
          });
        } else if (this.cachedToken) {
          this.setAuth(this.cachedToken);
        }
        break;

      case "ERROR":
      case "EMBED_ERROR":
        if (this.options.onError) {
          this.options.onError(data.payload?.code ?? "UNKNOWN", data.payload?.message ?? "");
        }
        break;

      case "CONVERSATION_CHANGED":
        this.options.onConversationChange?.(data.payload?.conversationId ?? null);
        break;

      // --- Stateless parent-persistence lifecycle (fragment c776f8b1) ---
      case "CONVERSATION_CREATED":
        this.options.onConversationCreated?.(data.payload as StatelessConversationPayload);
        break;

      case "MESSAGE_CREATED":
        this.options.onMessageCreated?.(data.payload as StatelessMessageCreatedPayload);
        break;

      case "CONVERSATION_RENAMED":
        this.options.onConversationRenamed?.(data.payload as ConversationRenamedPayload);
        break;

      case "CONVERSATION_MESSAGES_UPSERTED":
        this.options.onConversationMessagesUpserted?.(
          data.payload as ConversationMessagesUpsertedPayload
        );
        break;

      default:
        break;
    }
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  private postToIframe(message: unknown): void {
    const target = this.iframeOrigin === "*" ? "*" : this.iframeOrigin;
    this.iframe.contentWindow?.postMessage(message, target);
  }
}
