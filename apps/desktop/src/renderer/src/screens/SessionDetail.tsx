import { useState, useCallback } from "react";
import { useParams, useNavigate } from "react-router-dom";
import type { RemoteApprovalRequest } from "@vi/client-sdk";
import { useOverview } from "../hooks/useOverview";
import { getClient } from "../client";

function riskColor(r: string): string {
  if (r === "critical") return "#b71c1c";
  if (r === "high") return "#f44336";
  if (r === "medium") return "#ff9800";
  return "#4caf50";
}

export default function SessionDetail() {
  const { id: jobId } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { overview, loading, error, refresh } = useOverview(3000);

  const [inputText, setInputText] = useState("");
  const [sendingInput, setSendingInput] = useState(false);
  const [respondingTo, setRespondingTo] = useState<string | null>(null);
  const [replyTexts, setReplyTexts] = useState<Record<string, string>>({});

  const job = overview?.jobs.find((j) => j.jobId === jobId);
  const agent = overview?.agents.find((a) => a.agentId === job?.agentId);
  const approvals = overview?.requests.filter(
    (r) => r.status === "open" && r.agentId === job?.agentId,
  ) ?? [];

  const handleSendInput = useCallback(async () => {
    const text = inputText.trim();
    if (!text || !jobId) return;
    setSendingInput(true);
    try {
      const client = await getClient();
      await client.sendJobInput(jobId, { text, submit: true });
      setInputText("");
      refresh();
    } catch (err) {
      alert(err instanceof Error ? err.message : "Failed to send input");
    } finally {
      setSendingInput(false);
    }
  }, [inputText, jobId, refresh]);

  const handleRespond = useCallback(async (
    request: RemoteApprovalRequest,
    action: "approve" | "reject",
    response?: string,
  ) => {
    setRespondingTo(request.requestId);
    try {
      const client = await getClient();
      await client.respondToRemoteApproval({ requestId: request.requestId, action, response });
      refresh();
    } catch (err) {
      alert(err instanceof Error ? err.message : "Failed to respond");
    } finally {
      setRespondingTo(null);
    }
  }, [refresh]);

  if (loading && !overview) return <div style={s.center}><p style={s.gray}>Loading…</p></div>;
  if (error && !overview) return (
    <div style={s.center}>
      <p style={s.errorText}>{error}</p>
      <button style={s.btn} onClick={refresh}>Retry</button>
    </div>
  );
  if (!job) return (
    <div style={s.center}>
      <p style={s.gray}>Session not found</p>
      <button style={s.btn} onClick={() => navigate("/sessions")}>Back</button>
    </div>
  );

  const canSendInput = job.status === "running" || job.status === "queued";
  const logLines = job.logTail?.split("\n").slice(-40).join("\n") ?? "";

  return (
    <div style={s.page}>
      <div style={s.toolbar}>
        <button style={s.backBtn} onClick={() => navigate("/sessions")}>← Back</button>
        <button style={s.refreshBtn} onClick={refresh} title="Refresh">↻</button>
      </div>
      <div style={s.scroll}>
        <h2 style={s.title}>{job.title}</h2>

        {/* Meta */}
        <div style={s.metaGrid}>
          {agent && <MetaRow label="Machine" value={agent.displayName} />}
          {job.cwd && <MetaRow label="CWD" value={job.cwd} />}
          {job.model && <MetaRow label="Model" value={job.model} />}
          <MetaRow label="Status" value={job.status} />
          {job.providerState && (
            <MetaRow label="State" value={`${job.providerState.state}${job.providerState.reason ? ` — ${job.providerState.reason}` : ""}`} />
          )}
        </div>

        {/* Log tail */}
        {logLines && (
          <Section title="Recent Output">
            <pre style={s.logPre}>{logLines}</pre>
          </Section>
        )}

        {/* Pending approvals */}
        {approvals.length > 0 && (
          <Section title={`Pending Approvals (${approvals.length})`}>
            {approvals.map((req) => (
              <div key={req.requestId} style={s.approvalCard}>
                <div style={s.approvalTop}>
                  <span style={{ ...s.riskBadge, background: riskColor(req.riskLevel) }}>{req.riskLevel.toUpperCase()}</span>
                  <span style={s.approvalTitle}>{req.title}</span>
                </div>
                {req.command && <pre style={s.command}>{req.command}</pre>}
                <p style={s.message}>{req.message}</p>
                {req.primaryAction === "reply" && (
                  <textarea
                    style={s.replyInput}
                    value={replyTexts[req.requestId] ?? ""}
                    onChange={(e) => setReplyTexts((p) => ({ ...p, [req.requestId]: e.target.value }))}
                    placeholder="Your reply…"
                    rows={3}
                  />
                )}
                <div style={s.actionRow}>
                  <button
                    style={s.rejectBtn}
                    onClick={() => handleRespond(req, "reject")}
                    disabled={respondingTo === req.requestId}
                  >Reject</button>
                  <button
                    style={s.approveBtn}
                    onClick={() => handleRespond(req, "approve", replyTexts[req.requestId]?.trim() || undefined)}
                    disabled={respondingTo === req.requestId}
                  >{respondingTo === req.requestId ? "…" : req.primaryAction === "reply" ? "Send Reply" : "Approve"}</button>
                </div>
              </div>
            ))}
          </Section>
        )}

        {/* Send input */}
        {canSendInput && (
          <Section title="Send Input">
            <p style={s.partialNote}>Input delivery pending vi-agent update — queued at relay, not yet forwarded to Claude.</p>
            <div style={s.inputRow}>
              <textarea
                style={s.textInput}
                value={inputText}
                onChange={(e) => setInputText(e.target.value)}
                placeholder="Type input for the agent…"
                rows={3}
              />
              <button
                style={{ ...s.sendBtn, opacity: (!inputText.trim() || sendingInput) ? 0.4 : 1 }}
                onClick={handleSendInput}
                disabled={!inputText.trim() || sendingInput}
              >{sendingInput ? "…" : "Send"}</button>
            </div>
          </Section>
        )}
      </div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{ marginTop: 20 }}>
      <p style={{ fontSize: 12, fontWeight: 700, color: "#888", textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 8 }}>{title}</p>
      {children}
    </div>
  );
}

function MetaRow({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ display: "flex", padding: "6px 0", borderBottom: "1px solid #f0f0f0" }}>
      <span style={{ width: 80, fontSize: 13, color: "#888", fontWeight: 600, flexShrink: 0 }}>{label}</span>
      <span style={{ fontSize: 13, color: "#111", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{value}</span>
    </div>
  );
}

const s: Record<string, React.CSSProperties> = {
  page: { flex: 1, display: "flex", flexDirection: "column", overflow: "hidden" },
  toolbar: { padding: "12px 20px", display: "flex", justifyContent: "space-between", alignItems: "center", borderBottom: "1px solid #e0e0e0", background: "#fff" },
  backBtn: { background: "none", border: "none", fontSize: 15, cursor: "pointer", color: "#333", fontWeight: 600 },
  refreshBtn: { background: "none", border: "none", fontSize: 20, cursor: "pointer", color: "#555" },
  scroll: { flex: 1, overflowY: "auto", padding: "20px 24px" },
  title: { fontSize: 20, fontWeight: 700, marginBottom: 14 },
  metaGrid: { background: "#fff", borderRadius: 10, padding: "4px 14px", border: "1px solid #e8e8e8" },
  logPre: { fontFamily: "monospace", fontSize: 12, lineHeight: 1.6, background: "#1e1e1e", color: "#d4d4d4", padding: 14, borderRadius: 8, overflowX: "auto", whiteSpace: "pre-wrap", wordBreak: "break-all" },
  approvalCard: { background: "#fff", border: "1px solid #e8e8e8", borderRadius: 10, padding: 16, marginBottom: 10 },
  approvalTop: { display: "flex", alignItems: "flex-start", gap: 10, marginBottom: 8 },
  riskBadge: { borderRadius: 4, padding: "2px 7px", color: "#fff", fontSize: 11, fontWeight: 700, flexShrink: 0 },
  approvalTitle: { fontSize: 14, fontWeight: 600 },
  command: { fontFamily: "monospace", fontSize: 12, background: "#f5f5f5", padding: "8px 10px", borderRadius: 6, marginBottom: 8, whiteSpace: "pre-wrap", wordBreak: "break-all" },
  message: { fontSize: 13, color: "#444", marginBottom: 12 },
  replyInput: { width: "100%", padding: "10px", fontSize: 13, border: "1px solid #ccc", borderRadius: 8, marginBottom: 10, resize: "vertical" },
  actionRow: { display: "flex", gap: 10 },
  rejectBtn: { flex: 1, padding: "9px 0", border: "1.5px solid #f44336", borderRadius: 8, color: "#f44336", background: "none", fontWeight: 700, cursor: "pointer" },
  approveBtn: { flex: 1, padding: "9px 0", background: "#000", color: "#fff", border: "none", borderRadius: 8, fontWeight: 700, cursor: "pointer" },
  partialNote: { fontSize: 12, color: "#e65100", fontStyle: "italic", marginBottom: 10 },
  inputRow: { display: "flex", gap: 10, alignItems: "flex-end" },
  textInput: { flex: 1, padding: "10px", fontSize: 14, border: "1px solid #ccc", borderRadius: 8, resize: "vertical" },
  sendBtn: { padding: "10px 20px", background: "#000", color: "#fff", border: "none", borderRadius: 8, fontWeight: 700, cursor: "pointer" },
  center: { flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 16 },
  gray: { color: "#888" },
  errorText: { color: "#f44336" },
  btn: { padding: "8px 20px", background: "#000", color: "#fff", border: "none", borderRadius: 8, cursor: "pointer", fontWeight: 600 },
};
