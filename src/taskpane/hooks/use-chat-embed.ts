import { RefObject, useEffect, useRef } from "react";
import { UsableChatEmbed } from "../lib/embed-sdk";
import { excelToolSchemas, handleExcelToolCall } from "../lib/excel-tools";

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

export function useChatEmbed(iframeRef: RefObject<HTMLIFrameElement>): void {
  const embedRef = useRef<UsableChatEmbed | null>(null);

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

    // Update the iframe src with the embed token
    const targetSrc = `${IFRAME_ORIGIN}/embed?token=${encodeURIComponent(embedToken)}`;
    if (iframe.src !== targetSrc) {
      iframe.src = targetSrc;
    }

    // Create the embed SDK instance
    const embed = new UsableChatEmbed(iframe, {
      iframeOrigin: IFRAME_ORIGIN,

      onToolCall: async (tool, args, _requestId) => {
        return handleExcelToolCall(tool, args);
      },

      onError: (code, message) => {
        console.error(`[UsableEmbed] Error ${code}: ${message}`);
      },
    });

    embedRef.current = embed;

    // On READY: send auth (if any) and register tools
    embed.onReady(() => {
      // Try to get a cached JWT from roaming settings
      try {
        const cachedToken = Office.context.roamingSettings.get("usableJwt") as string | null;
        if (cachedToken) {
          embed.setAuth(cachedToken);
        }
      } catch {
        // no cached token — user will authenticate inside the iframe
      }

      // Register all 20 Excel tool schemas with the embed
      embed.registerTools(excelToolSchemas);
    });

    return () => {
      embed.destroy();
      embedRef.current = null;
    };
  }, [iframeRef]);
}
