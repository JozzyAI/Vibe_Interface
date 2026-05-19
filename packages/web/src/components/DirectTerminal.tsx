"use client";

import { useEffect, useRef, useState, useMemo } from "react";
import { useRouter, usePathname, useSearchParams } from "next/navigation";
import { useTheme } from "next-themes";
import { cn } from "@/lib/cn";
import { useMux } from "@/hooks/useMux";

// Import xterm CSS (must be imported in client component)
import "xterm/css/xterm.css";

// Dynamically import xterm types for TypeScript
import type { ITheme, Terminal as TerminalType } from "xterm";
import type { FitAddon as FitAddonType } from "@xterm/addon-fit";

interface DirectTerminalProps {
  sessionId: string;
  startFullscreen?: boolean;
  /** Visual variant. Orchestrator keeps the same design-system blue accent as the rest of the app. */
  variant?: "agent" | "orchestrator";
  appearance?: "theme" | "dark";
  /** CSS height for the terminal container in normal (non-fullscreen) mode.
   *  Defaults to "max(440px, calc(100vh - 440px))". */
  height?: string;
  isOpenCodeSession?: boolean;
  reloadCommand?: string;
  chromeless?: boolean;
  readOnly?: boolean;
  showFloatingControls?: boolean;
  fontSize?: number;
  /** When "completed", suppress the "[Terminal exited with code N]" notice from MuxProvider. */
  jobStatus?: string;
}

type TerminalVariant = "agent" | "orchestrator";


export function buildTerminalThemes(variant: TerminalVariant): { dark: ITheme; light: ITheme } {
  const agentAccent = {
    cursor: "#5b7ef8",
    selDark: "rgba(91, 126, 248, 0.30)",
    selLight: "rgba(91, 126, 248, 0.25)",
  };
  const orchAccent = agentAccent;
  const accent = variant === "orchestrator" ? orchAccent : agentAccent;

  const dark: ITheme = {
    background: "#0a0a0f",
    foreground: "#d4d4d8",
    cursor: accent.cursor,
    cursorAccent: "#0a0a0f",
    selectionBackground: accent.selDark,
    selectionInactiveBackground: "rgba(128, 128, 128, 0.2)",
    // ANSI colors — slightly warmer than pure defaults
    black: "#1a1a24",
    red: "#ef4444",
    green: "#22c55e",
    yellow: "#f59e0b",
    blue: "#5b7ef8",
    magenta: "#a371f7",
    cyan: "#22d3ee",
    white: "#d4d4d8",
    brightBlack: "#50506a",
    brightRed: "#f87171",
    brightGreen: "#4ade80",
    brightYellow: "#fbbf24",
    brightBlue: "#7b9cfb",
    brightMagenta: "#c084fc",
    brightCyan: "#67e8f9",
    brightWhite: "#eeeef5",
  };

  const light: ITheme = {
    background: "#fafafa",
    foreground: "#24292f",
    cursor: accent.cursor,
    cursorAccent: "#fafafa",
    selectionBackground: accent.selLight,
    selectionInactiveBackground: "rgba(128, 128, 128, 0.15)",
    // ANSI colors — darkened for legibility on #fafafa terminal background
    black: "#24292f",
    red: "#b42318",
    green: "#1f7a3d",
    yellow: "#8a5a00",
    blue: "#175cd3",
    magenta: "#8e24aa",
    cyan: "#0b7285",
    white: "#4b5563",
    brightBlack: "#374151",
    brightRed: "#912018",
    brightGreen: "#176639",
    brightYellow: "#6f4a00",
    brightBlue: "#1d4ed8",
    brightMagenta: "#7b1fa2",
    brightCyan: "#155e75",
    brightWhite: "#374151",
  };

  return { dark, light };
}

/**
 * Direct xterm.js terminal with native WebSocket connection.
 * Implements Extended Device Attributes (XDA) handler to enable
 * tmux clipboard support (OSC 52) without requiring iTerm2 attachment.
 *
 * Based on DeepWiki analysis:
 * - tmux queries for XDA (CSI > q / XTVERSION) to detect terminal type
 * - When tmux sees "XTerm(" in response, it enables TTYC_MS (clipboard)
 * - xterm.js doesn't implement XDA by default, so we register custom handler
 */
export function DirectTerminal({
  sessionId,
  startFullscreen = false,
  variant = "agent",
  appearance = "theme",
  height = "max(440px, calc(100dvh - 440px))",
  isOpenCodeSession = false,
  reloadCommand,
  chromeless = false,
  readOnly = false,
  showFloatingControls = true,
  fontSize = 13,
  jobStatus,
}: DirectTerminalProps) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const { resolvedTheme } = useTheme();
  const terminalThemes = useMemo(() => buildTerminalThemes(variant), [variant]);
  const { subscribeTerminal, writeTerminal, resizeTerminal: resizeTerminalMux, openTerminal, closeTerminal, status: muxStatus } = useMux();

  const terminalRef = useRef<HTMLDivElement>(null);
  const terminalInstance = useRef<TerminalType | null>(null);
  const fitAddon = useRef<FitAddonType | null>(null);
  const muxStatusRef = useRef(muxStatus);
  muxStatusRef.current = muxStatus;
  const [fullscreen, setFullscreen] = useState(startFullscreen);
  const [error, setError] = useState<string | null>(null);
  const [reloading, setReloading] = useState(false);
  const [reloadError, setReloadError] = useState<string | null>(null);
  const [showHint, setShowHint] = useState(true);
  const hideHintRef = useRef<(() => void) | null>(null);

  // Update URL when fullscreen changes
  useEffect(() => {
    const params = new URLSearchParams(searchParams.toString());

    if (fullscreen) {
      params.set("fullscreen", "true");
    } else {
      params.delete("fullscreen");
    }

    const newUrl = params.toString() ? `${pathname}?${params.toString()}` : pathname;
    router.replace(newUrl, { scroll: false });
  }, [fullscreen, pathname, router, searchParams]);

  async function handleReload(): Promise<void> {
    if (!isOpenCodeSession || reloading) return;
    setReloadError(null);
    setReloading(true);
    try {
      let commandToSend = reloadCommand;

      if (!commandToSend) {
        const remapRes = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/remap`, {
          method: "POST",
        });
        if (!remapRes.ok) {
          throw new Error(`Failed to remap OpenCode session: ${remapRes.status}`);
        }
        const remapData = (await remapRes.json()) as { opencodeSessionId?: unknown };
        if (
          typeof remapData.opencodeSessionId !== "string" ||
          remapData.opencodeSessionId.length === 0
        ) {
          throw new Error("Missing OpenCode session id after remap");
        }
        commandToSend = `/exit\nopencode --session ${remapData.opencodeSessionId}\n`;
      }

      const sendRes = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/send`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: commandToSend }),
      });
      if (!sendRes.ok) {
        throw new Error(`Failed to send reload command: ${sendRes.status}`);
      }
    } catch (err) {
      setReloadError(err instanceof Error ? err.message : "Failed to reload OpenCode session");
    } finally {
      setReloading(false);
    }
  }

  useEffect(() => {
    if (!terminalRef.current) return;

    // Dynamically import xterm.js to avoid SSR issues
    let mounted = true;
    let cleanup: (() => void) | null = null;
    let inputDisposable: { dispose(): void } | null = null;
    let unsubscribe: (() => void) | null = null;

    Promise.all([
      import("xterm").then((mod) => mod.Terminal),
      import("@xterm/addon-fit").then((mod) => mod.FitAddon),
      import("@xterm/addon-web-links").then((mod) => mod.WebLinksAddon),
      document.fonts.ready,
    ])
      .then(([Terminal, FitAddon, WebLinksAddon]) => {
        if (!mounted || !terminalRef.current) return;

        const isDark = appearance === "dark" || resolvedTheme !== "light";
        const activeTheme = isDark ? terminalThemes.dark : terminalThemes.light;

        // Initialize xterm.js Terminal
        const terminal = new Terminal({
          cursorBlink: true,
          fontSize,
          fontFamily:
            'var(--font-jetbrains-mono), "JetBrains Mono", "SF Mono", Menlo, Monaco, "Courier New", monospace',
          theme: activeTheme,
          minimumContrastRatio: isDark ? 1 : 7,
          scrollback: 10000,
          allowProposedApi: true,
          fastScrollSensitivity: 8,
          scrollSensitivity: 3,
          macOptionIsMeta: true,
          rightClickSelectsWord: false,
          convertEol: false,
        });

        // Add FitAddon for responsive sizing
        const fit = new FitAddon();
        terminal.loadAddon(fit);
        fitAddon.current = fit;

        // Add WebLinksAddon for clickable links
        const webLinks = new WebLinksAddon();
        terminal.loadAddon(webLinks);

        // **CRITICAL FIX**: Register XDA (Extended Device Attributes) handler
        // This makes tmux recognize our terminal and enable clipboard support
        terminal.parser.registerCsiHandler(
          { prefix: ">", final: "q" }, // CSI > q is XTVERSION / XDA
          () => {
            // Respond with XTerm identification that tmux recognizes
            // tmux looks for "XTerm(" in the response (see tmux tty-keys.c)
            // Format: DCS > | XTerm(version) ST
            // DCS = \x1bP, ST = \x1b\\
            terminal.write("\x1bP>|XTerm(370)\x1b\\");
            console.log("[DirectTerminal] Sent XDA response for clipboard support");
            return true; // Handled
          },
        );

        // Register OSC 52 handler for clipboard support
        // tmux sends OSC 52 with base64-encoded text when copying
        terminal.parser.registerOscHandler(52, (data) => {
          const parts = data.split(";");
          if (parts.length < 2) return false;
          const b64 = parts[parts.length - 1];
          try {
            // Decode base64 → binary string → Uint8Array → UTF-8 text
            // atob() alone only handles Latin-1; TextDecoder is needed for UTF-8
            const binary = atob(b64);
            const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
            const text = new TextDecoder().decode(bytes);
            navigator.clipboard?.writeText(text).catch(() => {});
          } catch {
            // Ignore decode errors
          }
          return true;
        });

        // Open terminal in DOM
        terminal.open(terminalRef.current);
        terminalInstance.current = terminal;

        // Fit terminal to container
        fit.fit();

        // Copy via native clipboard event — no clearSelection() so highlight stays.
        const handleCopy = (e: ClipboardEvent) => {
          const selection = terminal.getSelection();
          if (!selection) return;
          e.preventDefault();
          e.clipboardData?.setData("text/plain", selection);
        };
        terminalRef.current?.addEventListener("copy", handleCopy, true);

        // Paste via native clipboard event — uses terminal.paste() for correct
        // bracketed paste mode handling (same approach as Paseo).
        const handlePaste = (e: ClipboardEvent) => {
          if (readOnly) return;
          const text = e.clipboardData?.getData("text/plain") ?? "";
          if (!text) return;
          e.preventDefault();
          e.stopPropagation();
          terminal.paste(text);
        };
        terminalRef.current?.addEventListener("paste", handlePaste, true);

        // Right-click: copy if selection, else paste.
        const handleContextMenu = (e: MouseEvent) => {
          e.preventDefault();
          const selection = terminal.getSelection();
          if (selection) {
            navigator.clipboard?.writeText(selection).catch(() => {});
          } else if (!readOnly) {
            navigator.clipboard?.readText().then((text) => {
              if (text) terminal.paste(text);
            }).catch(() => {});
          }
        };
        terminalRef.current?.addEventListener("contextmenu", handleContextMenu);

        // Ctrl+C with selection → copy (suppress SIGINT). Cmd+C on Mac.
        // Ctrl+Shift+C is NOT used — the browser intercepts it for DevTools
        // before JavaScript can see it, so it cannot be overridden.
        // Cmd+V / Ctrl+Shift+V → paste fallback.
        terminal.attachCustomKeyEventHandler((e: KeyboardEvent) => {
          if (e.type !== "keydown") return true;

          // Ctrl+C / Cmd+C — copy selection; when no selection, pass through as normal SIGINT/interrupt.
          const isCopy =
            (e.ctrlKey && !e.shiftKey && !e.metaKey && e.code === "KeyC") ||
            (e.metaKey && !e.ctrlKey && !e.altKey && e.code === "KeyC");
          if (isCopy && terminal.hasSelection()) {
            navigator.clipboard?.writeText(terminal.getSelection()).catch(() => {});
            return false; // suppress SIGINT when copying
          }

          // Cmd+V / Ctrl+Shift+V — paste
          const isPaste =
            (e.metaKey && !e.ctrlKey && !e.altKey && e.code === "KeyV") ||
            (e.ctrlKey && e.shiftKey && e.code === "KeyV");
          if (isPaste && !readOnly) {
            navigator.clipboard?.readText().then((text) => {
              if (text) terminal.paste(text);
            }).catch(() => {});
            return false;
          }

          return true;
        });

        // Open terminal via mux
        openTerminal(sessionId);

        // Register the hint-hide callback so the hint disappears on first output.
        hideHintRef.current = () => setShowHint(false);

        // Write data directly — no buffering.
        unsubscribe = subscribeTerminal(sessionId, (data) => {
          // Suppress the PTY-gone notice for completed jobs — expected exit, not an error.
          if (jobStatus === "completed" && data.includes("[Terminal exited with code")) return;
          terminal.write(data);
          // Hide hint on first byte of real output.
          if (hideHintRef.current) {
            hideHintRef.current();
            hideHintRef.current = null;
          }
        });

        // Handle window resize
        const handleResize = () => {
          if (fit) {
            fit.fit();
            resizeTerminalMux(sessionId, terminal.cols, terminal.rows);
          }
        };
        window.addEventListener("resize", handleResize);

        if (!readOnly) {
          inputDisposable = terminal.onData((data) => {
            writeTerminal(sessionId, data);
          });
        }

        // Send initial size
        resizeTerminalMux(sessionId, terminal.cols, terminal.rows);

        cleanup = () => {
          terminalRef.current?.removeEventListener("copy", handleCopy, true);
          terminalRef.current?.removeEventListener("paste", handlePaste, true);
          terminalRef.current?.removeEventListener("contextmenu", handleContextMenu);
          window.removeEventListener("resize", handleResize);
          inputDisposable?.dispose();
          inputDisposable = null;
          unsubscribe?.();
          closeTerminal(sessionId);
          terminal.dispose();
        };
      })
      .catch((err) => {
        console.error("[DirectTerminal] Failed to load xterm.js:", err);
        setError("Failed to load terminal");
      });

    return () => {
      mounted = false;
      cleanup?.();
    };
  }, [
    appearance,
    sessionId,
    variant,
    resolvedTheme,
    terminalThemes,
    subscribeTerminal,
    writeTerminal,
    resizeTerminalMux,
    openTerminal,
    closeTerminal,
    readOnly,
    fontSize,
  ]);

  // Re-send terminal dimensions on every reconnect so the server-side PTY
  // matches the client's xterm.js size (new PTYs spawn at 80×24 default).
  useEffect(() => {
    if (muxStatus !== "connected") return;
    const fit = fitAddon.current;
    const terminal = terminalInstance.current;
    if (!fit || !terminal) return;
    fit.fit();
    resizeTerminalMux(sessionId, terminal.cols, terminal.rows);
  }, [muxStatus, sessionId, resizeTerminalMux]);

  // Live theme switching without terminal recreation
  useEffect(() => {
    const terminal = terminalInstance.current;
    if (!terminal) return;
    const isDark = appearance === "dark" || resolvedTheme !== "light";
    terminal.options.theme = isDark ? terminalThemes.dark : terminalThemes.light;
    terminal.options.minimumContrastRatio = isDark ? 1 : 7;
  }, [appearance, resolvedTheme, terminalThemes]);

  // Re-fit terminal when fullscreen changes
  useEffect(() => {
    const fit = fitAddon.current;
    const terminal = terminalInstance.current;
    const container = terminalRef.current;

    if (!fit || !terminal || muxStatusRef.current !== "connected" || !container) {
      return;
    }

    let resizeAttempts = 0;
    const maxAttempts = 60;
    let cancelled = false;
    let rafId = 0;
    let lastHeight = -1;

    const resizeTerminal = () => {
      if (cancelled) return;
      resizeAttempts++;

      // Wait for the container height to stabilise (CSS transition finished)
      const currentHeight = container.getBoundingClientRect().height;
      const settled = lastHeight >= 0 && Math.abs(currentHeight - lastHeight) < 1;
      lastHeight = currentHeight;

      if (!settled && resizeAttempts < maxAttempts) {
        // Container is still transitioning, try again next frame
        rafId = requestAnimationFrame(resizeTerminal);
        return;
      }

      // Container is at target size, now resize terminal
      terminal.refresh(0, terminal.rows - 1);
      fit.fit();
      terminal.refresh(0, terminal.rows - 1);

      // Send new size to server via mux
      resizeTerminalMux(sessionId, terminal.cols, terminal.rows);
    };

    // Start resize polling
    rafId = requestAnimationFrame(resizeTerminal);

    // Also try on transitionend
    const handleTransitionEnd = (e: TransitionEvent) => {
      if (cancelled) return;
      if (e.target === container.parentElement) {
        resizeAttempts = 0;
        lastHeight = -1;
        setTimeout(() => {
          if (!cancelled) rafId = requestAnimationFrame(resizeTerminal);
        }, 50);
      }
    };

    const parent = container.parentElement;
    parent?.addEventListener("transitionend", handleTransitionEnd);

    // Backup timers in case RAF polling doesn't work
    const timer1 = setTimeout(() => {
      if (cancelled) return;
      resizeAttempts = 0;
      lastHeight = -1;
      resizeTerminal();
    }, 300);
    const timer2 = setTimeout(() => {
      if (cancelled) return;
      resizeAttempts = 0;
      lastHeight = -1;
      resizeTerminal();
    }, 600);

    return () => {
      cancelled = true;
      cancelAnimationFrame(rafId);
      parent?.removeEventListener("transitionend", handleTransitionEnd);
      clearTimeout(timer1);
      clearTimeout(timer2);
    };
  }, [fullscreen, sessionId, resizeTerminalMux]);

  const accentColor = "var(--color-accent)";

  // Local errors (e.g. xterm.js load failure) take priority over mux connection state
  const displayStatus = error ? "error" : muxStatus;

  const statusDotClass =
    displayStatus === "connected"
      ? "bg-[var(--color-status-ready)]"
      : displayStatus === "error" || displayStatus === "disconnected"
        ? "bg-[var(--color-status-error)]"
        : "bg-[var(--color-status-attention)] animate-[pulse_1.5s_ease-in-out_infinite]";

  const statusText =
    displayStatus === "connected"
      ? "Connected"
      : displayStatus === "error"
        ? (error ?? "Error")
        : displayStatus === "disconnected"
          ? "Disconnected"
          : "Connecting…";

  const statusTextColor =
    displayStatus === "connected"
      ? "text-[var(--color-status-ready)]"
      : displayStatus === "error" || displayStatus === "disconnected"
        ? "text-[var(--color-status-error)]"
        : "text-[var(--color-text-tertiary)]";
  const isDarkChrome = appearance === "dark" || resolvedTheme !== "light";
  const fullscreenButton = (
    <button
      onClick={() => setFullscreen(!fullscreen)}
      className={cn(
        "flex items-center gap-1 px-2 py-0.5 text-[11px] text-[var(--color-text-tertiary)] transition-colors hover:bg-[var(--color-bg-subtle)] hover:text-[var(--color-text-primary)]",
        !isOpenCodeSession && !chromeless && "ml-auto",
      )}
      aria-label={fullscreen ? "exit fullscreen" : "fullscreen"}
    >
      {fullscreen ? (
        <>
          <svg
            className="h-3 w-3"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            viewBox="0 0 24 24"
          >
            <path d="M8 3v3a2 2 0 01-2 2H3m18 0h-3a2 2 0 01-2-2V3m0 18v-3a2 2 0 012-2h3M3 16h3a2 2 0 012 2v3" />
          </svg>
          exit fullscreen
        </>
      ) : (
        <>
          <svg
            className="h-3 w-3"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            viewBox="0 0 24 24"
          >
            <path d="M8 3H5a2 2 0 00-2 2v3m18 0V5a2 2 0 00-2-2h-3m0 18h3a2 2 0 002-2v-3M3 16v3a2 2 0 002 2h3" />
          </svg>
          fullscreen
        </>
      )}
    </button>
  );

  return (
    <div
      className={cn(
        "overflow-hidden border border-[var(--color-border-default)]",
        fullscreen ? "fixed inset-0 z-50 rounded-none border-0" : "relative",
        isDarkChrome ? "bg-[#0a0a0f]" : "bg-[#fafafa]",
        chromeless && "border-0",
      )}
    >
      {!chromeless ? (
        <div className="flex items-center gap-2 border-b border-[var(--color-border-subtle)] bg-[var(--color-bg-elevated)] px-3 py-2">
          <div className={cn("h-2 w-2 shrink-0 rounded-full", statusDotClass)} />
          <span className="font-[var(--font-mono)] text-[11px]" style={{ color: accentColor }}>
            {sessionId}
          </span>
          <span
            className={cn("text-[10px] font-medium uppercase tracking-[0.06em]", statusTextColor)}
          >
            {statusText}
          </span>
          <span
            className="px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-[0.06em]"
            style={{
              color: accentColor,
              background: `color-mix(in srgb, ${accentColor} 12%, transparent)`,
            }}
          >
            XDA
          </span>
          {isOpenCodeSession ? (
            <button
              onClick={handleReload}
              disabled={reloading || muxStatus !== "connected"}
              title="Restart OpenCode session (/exit then resume mapped session)"
              aria-label="Restart OpenCode session"
              className="ml-auto flex items-center gap-1 px-2 py-0.5 text-[11px] text-[var(--color-text-tertiary)] transition-colors hover:bg-[var(--color-bg-subtle)] hover:text-[var(--color-text-primary)] disabled:cursor-not-allowed disabled:opacity-70"
            >
              {reloading ? (
                <>
                  <svg
                    className="h-3 w-3 animate-spin"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    viewBox="0 0 24 24"
                  >
                    <path d="M12 3a9 9 0 109 9" />
                  </svg>
                  restarting
                </>
              ) : (
                <>
                  <svg
                    className="h-3 w-3"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    viewBox="0 0 24 24"
                  >
                    <path d="M21 12a9 9 0 11-2.64-6.36" />
                    <path d="M21 3v6h-6" />
                  </svg>
                  restart
                </>
              )}
            </button>
          ) : null}
          {reloadError ? (
            <span
              className="max-w-[40ch] truncate text-[10px] font-medium text-[var(--color-status-error)]"
              title={reloadError}
            >
              {reloadError}
            </span>
          ) : null}
          {fullscreenButton}
        </div>
      ) : null}
      {chromeless && showFloatingControls ? (
        <div className="absolute right-3 top-3 z-10 flex items-center gap-1 rounded-[6px] border border-[var(--color-border-subtle)] bg-[color-mix(in_srgb,var(--color-bg-elevated)_92%,transparent)] px-1.5 py-1 shadow-[0_8px_24px_rgba(0,0,0,0.18)] backdrop-blur-sm">
          {isOpenCodeSession ? (
            <button
              onClick={handleReload}
              disabled={reloading || muxStatus !== "connected"}
              title="Restart OpenCode session (/exit then resume mapped session)"
              aria-label="Restart OpenCode session"
              className="flex items-center gap-1 px-2 py-0.5 text-[11px] text-[var(--color-text-tertiary)] transition-colors hover:bg-[var(--color-bg-subtle)] hover:text-[var(--color-text-primary)] disabled:cursor-not-allowed disabled:opacity-70"
            >
              {reloading ? (
                <>
                  <svg
                    className="h-3 w-3 animate-spin"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    viewBox="0 0 24 24"
                  >
                    <path d="M12 3a9 9 0 109 9" />
                  </svg>
                  restarting
                </>
              ) : (
                <>
                  <svg
                    className="h-3 w-3"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    viewBox="0 0 24 24"
                  >
                    <path d="M21 12a9 9 0 11-2.64-6.36" />
                    <path d="M21 3v6h-6" />
                  </svg>
                  restart
                </>
              )}
            </button>
          ) : null}
          {fullscreenButton}
        </div>
      ) : null}
      {/* Terminal area */}
      <div className="relative w-full" style={{ height: fullscreen ? `calc(100dvh - ${chromeless ? "0px" : "37px"})` : height }}>
        <div
          ref={terminalRef}
          className={cn("h-full w-full p-1.5")}
          style={{ overflow: "hidden", display: "flex", flexDirection: "column" }}
        />
        {showHint ? (
          <div
            className="pointer-events-none absolute bottom-8 left-0 right-0 flex justify-center"
            aria-hidden
          >
            <div className="rounded px-3 py-2 text-center font-mono text-[10px] leading-[1.7] text-[rgba(255,255,255,0.18)]">
              <span className="block opacity-70">Copy / paste</span>
              <span className="block">Ctrl+C with selection → copies &nbsp;·&nbsp; Ctrl+C without → interrupt</span>
              <span className="block">Right-click → copy / paste &nbsp;·&nbsp; Cmd+V / Ctrl+Shift+V → paste</span>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}
