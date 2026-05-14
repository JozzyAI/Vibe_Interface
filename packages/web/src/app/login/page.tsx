"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export default function LoginPage() {
  const [token, setToken] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const router = useRouter();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token }),
      });
      if (!res.ok) {
        const data = (await res.json()) as { error?: string };
        setError(data.error ?? "Invalid access token");
        return;
      }
      const from = new URLSearchParams(window.location.search).get("from") ?? "/";
      router.push(from);
    } catch {
      setError("Connection error — please try again");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-[var(--color-bg-base)]">
      <div className="w-full max-w-[380px] px-4">
        <div className="mb-8 text-center">
          <div className="mx-auto mb-4 grid h-14 w-14 place-items-center rounded-2xl border border-[#9ed9e5] bg-[#0b8ea6] text-[17px] font-bold text-white shadow-sm">
            PI
          </div>
          <h1 className="text-[22px] font-semibold text-[var(--color-text-primary)]">
            Access PI
          </h1>
          <p className="mt-1 text-[13px] text-[var(--color-text-tertiary)]">
            Enter your access token to continue
          </p>
        </div>

        <form
          onSubmit={handleSubmit}
          className="rounded-2xl border border-[var(--color-border-default)] bg-[var(--color-bg-surface)] p-6 shadow-sm"
        >
          <label className="block text-[11px] font-semibold uppercase tracking-[0.1em] text-[var(--color-text-tertiary)]">
            Access token
          </label>
          <input
            type="password"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            autoFocus
            autoComplete="current-password"
            placeholder="••••••••••••"
            className="mt-2 w-full rounded-xl border border-[var(--color-border-default)] bg-[var(--color-bg-base)] px-4 py-2.5 text-[14px] text-[var(--color-text-primary)] placeholder-[var(--color-text-muted)] outline-none focus:border-[#0b8ea6] focus:ring-2 focus:ring-[#0b8ea6]/20"
          />
          {error ? (
            <p className="mt-2 text-[12px] text-[var(--color-accent-red)]">{error}</p>
          ) : null}
          <button
            type="submit"
            disabled={loading || !token.trim()}
            className="mt-4 w-full rounded-xl bg-[#0b8ea6] py-2.5 text-[14px] font-semibold text-white transition hover:bg-[#0a7d93] disabled:cursor-not-allowed disabled:opacity-50"
          >
            {loading ? "Signing in…" : "Sign in"}
          </button>
        </form>

        <p className="mt-5 text-center text-[11px] text-[var(--color-text-muted)]">
          Set <code className="font-mono">PI_ACCESS_TOKEN</code> in your environment to enable auth
        </p>
      </div>
    </div>
  );
}
