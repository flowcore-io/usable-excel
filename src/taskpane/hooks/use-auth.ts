/**
 * useAuth — Keycloak OAuth PKCE authentication for the Excel Add-In.
 *
 * Flow:
 *  1. On mount: try to restore session from cached refresh token (silent).
 *  2. If no session: state = "unauthenticated" → caller shows a login button.
 *  3. login() opens the Office Dialog which runs the PKCE flow.
 *  4. On success: token cached in roamingSettings, state = "authenticated".
 *  5. Silent refresh scheduled 30 s before expiry via the Keycloak proxy.
 */

import { useCallback, useEffect, useRef, useState } from "react";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const KC_TOKEN_URL = "/auth/token"; // proxied by webpack → auth.flowcore.io
const CLIENT_ID    = "mcp_oauth_client";

/** roamingSettings key for the Keycloak refresh token */
const RT_KEY = "usableRefreshToken";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type AuthState = "restoring" | "unauthenticated" | "authenticated";

export interface AuthResult {
  state: AuthState;
  accessToken: string | null;
  login: () => void;
  logout: () => void;
  /** Fetch a fresh access token using the stored refresh token. */
  refreshAccessToken: () => Promise<string | null>;
}

// ---------------------------------------------------------------------------
// Token exchange helpers
// ---------------------------------------------------------------------------

async function exchangeRefreshToken(rt: string): Promise<{ accessToken: string; refreshToken: string | null; expiresIn: number } | null> {
  const body = new URLSearchParams({
    grant_type:    "refresh_token",
    client_id:     CLIENT_ID,
    refresh_token: rt,
  });

  const res = await fetch(KC_TOKEN_URL, {
    method:  "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body:    body.toString(),
  });

  if (!res.ok) return null;

  const tokens = await res.json() as {
    access_token:  string;
    refresh_token?: string;
    expires_in?:   number;
  };

  return {
    accessToken:  tokens.access_token,
    refreshToken: tokens.refresh_token ?? null,
    expiresIn:    tokens.expires_in    ?? 300,
  };
}

function saveRefreshToken(rt: string) {
  try {
    localStorage.setItem(RT_KEY, rt);
  } catch {
    // private browsing or storage quota
  }
}

function clearRefreshToken() {
  try {
    localStorage.removeItem(RT_KEY);
  } catch {
    // ignore
  }
}

function getStoredRefreshToken(): string | null {
  try {
    return localStorage.getItem(RT_KEY);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function useAuth(): AuthResult {
  const [state, setState]             = useState<AuthState>("restoring");
  const [accessToken, setAccessToken] = useState<string | null>(null);

  const refreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const dialogRef       = useRef<Office.Dialog | null>(null);

  // -------------------------------------------------------------------------
  // Schedule silent token refresh
  // -------------------------------------------------------------------------

  const scheduleRefresh = useCallback((expiresIn: number, doRefresh: () => void) => {
    if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current);
    const delay = Math.max((expiresIn - 30) * 1000, 10_000);
    refreshTimerRef.current = setTimeout(doRefresh, delay);
  }, []);

  // -------------------------------------------------------------------------
  // refreshAccessToken (exported so useChatEmbed can call it on demand)
  // -------------------------------------------------------------------------

  const refreshAccessToken = useCallback(async (): Promise<string | null> => {
    const rt = getStoredRefreshToken();
    if (!rt) return null;

    const result = await exchangeRefreshToken(rt);
    if (!result) {
      // Refresh failed — clear the bad refresh token but do NOT setState here.
      // Callers decide what to do: the mount effect will set "unauthenticated"
      // on startup; mid-session failures leave the user on the chat screen.
      clearRefreshToken();
      return null;
    }

    setAccessToken(result.accessToken);
    setState("authenticated");

    if (result.refreshToken) saveRefreshToken(result.refreshToken);

    scheduleRefresh(result.expiresIn, () => {
      refreshAccessToken();
    });

    return result.accessToken;
  }, [scheduleRefresh]);

  // -------------------------------------------------------------------------
  // Restore session on mount
  // -------------------------------------------------------------------------

  useEffect(() => {
    refreshAccessToken().then((token) => {
      if (!token) setState("unauthenticated");
    });

    return () => {
      if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current);
    };
  }, [refreshAccessToken]);

  // -------------------------------------------------------------------------
  // login — open Office Dialog with PKCE flow
  // -------------------------------------------------------------------------

  const login = useCallback(() => {
    const dialogUrl = `${window.location.origin}/auth-dialog.html`;

    Office.context.ui.displayDialogAsync(
      dialogUrl,
      { height: 60, width: 40, displayInIframe: false },
      (result) => {
        if (result.status === Office.AsyncResultStatus.Failed) {
          console.error("[Auth] Failed to open login dialog:", result.error.message);
          return;
        }

        const dialog = result.value;
        dialogRef.current = dialog;

        // Receive token (or error) from the dialog page
        dialog.addEventHandler(
          Office.EventType.DialogMessageReceived,
          (args: { message: string; origin: string | undefined } | { error: number }) => {
            if (!("message" in args)) return; // dialog error event, not a message
            let data: { type: string; accessToken?: string; refreshToken?: string; expiresIn?: number; error?: string };
            try {
              data = JSON.parse(args.message) as typeof data;
            } catch {
              return;
            }

            if (data.type === "AUTH_SUCCESS" && data.accessToken) {
              dialog.close();
              dialogRef.current = null;

              setAccessToken(data.accessToken);
              setState("authenticated");
              scheduleRefresh(data.expiresIn ?? 300, () => refreshAccessToken());

              if (data.refreshToken) saveRefreshToken(data.refreshToken);
            } else if (data.type === "AUTH_ERROR") {
              console.error("[Auth] Login dialog error:", data.error);
              dialog.close();
              dialogRef.current = null;
            }
          }
        );

        // Dialog closed by user without completing
        dialog.addEventHandler(
          Office.EventType.DialogEventReceived,
          () => {
            dialogRef.current = null;
          }
        );
      }
    );
  }, [scheduleRefresh, refreshAccessToken]);

  // -------------------------------------------------------------------------
  // logout
  // -------------------------------------------------------------------------

  const logout = useCallback(() => {
    clearRefreshToken();
    setAccessToken(null);
    setState("unauthenticated");
    if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current);
  }, []);

  return { state, accessToken, login, logout, refreshAccessToken };
}
