"use client";

import { useEffect, useMemo, useRef } from "react";

interface RemoteLogTerminalProps {
  content: string;
  height?: string;
}

function stripAnsi(input: string): string {
  const esc = String.fromCharCode(27);
  const bel = String.fromCharCode(7);
  return input
    .replace(new RegExp(`${esc}\\[[0-?]*[ -/]*[@-~]`, "g"), "")
    .replace(new RegExp(`${esc}\\][^${bel}]*(?:${bel}|${esc}\\\\)`, "g"), "")
    .replace(new RegExp(`${esc}[PX^_].*?${esc}\\\\`, "gs"), "")
    .replace(new RegExp(`${esc}[@-_]`, "g"), "");
}

export function RemoteLogTerminal({ content, height = "520px" }: RemoteLogTerminalProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const displayText = useMemo(() => {
    const cleaned = stripAnsi(content).trimEnd();
    return cleaned || "Waiting for remote output...";
  }, [content]);

  useEffect(() => {
    const element = scrollRef.current;
    if (!element) return;
    element.scrollTop = element.scrollHeight;
  }, [displayText]);

  return (
    <div
      ref={scrollRef}
      className="min-w-0 max-w-full overflow-auto bg-[#05060a] p-4 shadow-inner"
      style={{ height }}
    >
      <pre className="m-0 min-w-max whitespace-pre font-mono text-[12px] leading-5 text-[#d8e2ff]">
        {displayText}
      </pre>
    </div>
  );
}
