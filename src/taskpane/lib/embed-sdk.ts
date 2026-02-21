/**
 * UsableChatEmbed — PostMessage bridge between the Excel task pane and the
 * embedded Usable Chat iframe.
 *
 * Design notes (from reference implementation):
 * - Singleton message listener: one window.addEventListener per instance.
 * - Request deduplication via Set<string> to survive React StrictMode double-mounts.
 * - Auth token is cached so it can be re-sent on REQUEST_TOKEN_REFRESH.
 */

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

export interface UsableChatEmbedOptions {
  /** Expected origin of the iframe (e.g. "https://chat.usable.dev"). Use "*" to skip validation. */
  iframeOrigin?: string;
  onToolCall?: ToolCallHandler;
  onError?: (code: string, message: string) => void;
  onConversationChange?: (conversationId: string | null) => void;
  /** Called when the embed requests a fresh token. Return the new access token, or null on failure. */
  onTokenRefreshRequired?: () => Promise<string | null>;
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

    switch (data.type) {
      case "READY":
        this.isReady = true;
        this.readyCallbacks.forEach((cb) => cb());
        this.readyCallbacks = [];
        break;

      case "TOOL_CALL": {
        const payload = data.payload as ToolCallPayload;
        const { requestId, tool, args } = payload;

        // Deduplication
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
        if (this.options.onError) {
          this.options.onError(data.payload?.code ?? "UNKNOWN", data.payload?.message ?? "");
        }
        break;

      case "CONVERSATION_CHANGED":
        if (this.options.onConversationChange) {
          this.options.onConversationChange(data.payload?.conversationId ?? null);
        }
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
