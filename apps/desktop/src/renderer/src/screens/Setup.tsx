import { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { invalidateClient } from "../client";

export default function Setup() {
  const navigate = useNavigate();
  const [baseUrl, setBaseUrl] = useState("");
  const [token, setToken] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    window.electronAPI.getConfig().then((cfg) => {
      if (cfg) setBaseUrl(cfg.baseUrl);
      // Do not pre-fill token — require re-entry
    });
  }, []);

  async function handleSave() {
    const url = baseUrl.trim();
    const tok = token.trim();
    if (!url || !tok) { setError("Both fields are required."); return; }
    if (!/^https?:\/\//.test(url)) { setError("Relay URL must start with http:// or https://"); return; }
    setSaving(true);
    setError(null);
    try {
      await window.electronAPI.setConfig(url, tok);
      invalidateClient();
      navigate("/sessions");
    } catch {
      setError("Failed to save config.");
    } finally {
      setSaving(false);
    }
  }

  async function handleClear() {
    if (!confirm("Remove saved relay credentials?")) return;
    await window.electronAPI.clearConfig();
    invalidateClient();
    setBaseUrl("");
    setToken("");
  }

  return (
    <div style={s.page}>
      <div style={s.card}>
        <h2 style={s.heading}>Relay Connection</h2>

        <label style={s.label}>Relay Base URL</label>
        <input
          style={s.input}
          type="url"
          value={baseUrl}
          onChange={(e) => setBaseUrl(e.target.value)}
          placeholder="https://relay.dynastylab.ai"
          autoComplete="off"
          spellCheck={false}
        />

        <label style={s.label}>VI Token</label>
        <input
          style={s.input}
          type="password"
          value={token}
          onChange={(e) => setToken(e.target.value)}
          placeholder="Enter your VI token"
          autoComplete="off"
        />

        {error && <p style={s.errorText}>{error}</p>}

        <button style={{ ...s.btn, opacity: saving ? 0.5 : 1 }} onClick={handleSave} disabled={saving}>
          {saving ? "Saving…" : "Save & Connect"}
        </button>

        <button style={s.clearBtn} onClick={handleClear}>
          Clear saved credentials
        </button>

        <p style={s.note}>
          Token stored locally in plain JSON (MVP).{" "}
          <span style={{ color: "#e65100" }}>TODO: migrate to OS keychain.</span>
        </p>
      </div>
    </div>
  );
}

const s: Record<string, React.CSSProperties> = {
  page: { flex: 1, display: "flex", alignItems: "center", justifyContent: "center", background: "#f0f0f0" },
  card: { background: "#fff", borderRadius: 12, padding: 32, width: 420, boxShadow: "0 2px 16px rgba(0,0,0,0.1)" },
  heading: { fontSize: 22, fontWeight: 700, marginBottom: 28 },
  label: { display: "block", fontSize: 13, fontWeight: 600, color: "#666", marginBottom: 6, marginTop: 16 },
  input: { width: "100%", padding: "10px 12px", fontSize: 15, border: "1px solid #ccc", borderRadius: 8, outline: "none" },
  errorText: { color: "#f44336", fontSize: 13, marginTop: 10 },
  btn: { display: "block", width: "100%", marginTop: 24, padding: "12px 0", background: "#000", color: "#fff", border: "none", borderRadius: 8, fontSize: 16, fontWeight: 700, cursor: "pointer" },
  clearBtn: { display: "block", width: "100%", marginTop: 10, padding: "8px 0", background: "none", color: "#c00", border: "none", fontSize: 14, cursor: "pointer" },
  note: { marginTop: 20, fontSize: 12, color: "#888", lineHeight: 1.5 },
};
