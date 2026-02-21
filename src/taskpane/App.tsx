import * as React from "react";
import { useChatEmbed } from "./hooks/use-chat-embed";

const EMBED_PLACEHOLDER_SRC = "about:blank";

/**
 * App — full-screen Usable Chat iframe.
 *
 * The entire task pane is the iframe; no other UI is rendered.
 * The useChatEmbed hook manages the embed token, PostMessage bridge,
 * and Excel tool registrations.
 */
export function App(): React.ReactElement {
  const iframeRef = React.useRef<HTMLIFrameElement>(null);
  useChatEmbed(iframeRef);

  return (
    <iframe
      ref={iframeRef}
      src={EMBED_PLACEHOLDER_SRC}
      title="Usable Chat"
      style={{
        position: "fixed",
        top: 0,
        left: 0,
        width: "100%",
        height: "100%",
        border: "none",
        display: "block",
      }}
      allow="clipboard-read; clipboard-write"
    />
  );
}
