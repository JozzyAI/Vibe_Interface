import { useState, useCallback } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { useOverview } from "../hooks/useOverview";
import { getClient } from "../client";

function riskColor(r: string): string {
  if (r === "critical") return "#b71c1c";
  if (r === "high") return "#f44336";
  if (r === "medium") return "#ff9800";
  return "#4caf50";
}

function timeAgo(iso: string): string {
  const s = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  return `${Math.floor(s / 3600)}h ago`;
}

export default function ApprovalDetail() {
  const { id: requestId } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { overview, loading, refresh } = useOverview(5000);
  const [replyText, setReplyText] = useState("");
  const [responding, setResponding] = useState(false);

  const request = overview?.requests.find((r) => r.requestId === requestId);
  const agent = overview?.agents.find((a) => a.agentId === request?.agentId);
  const parentJob = request?.parentJobId ? overview?.jobs.find((j) => j.jobId === request.parentJobId) : null;

  const handleRespond = useCallback(async (action: "approve" | "reject", response?: string) => {
    if (!requestId) return;
    setResponding(true);
    try {
      const client = await getClient();
      await client.respondToRemoteApproval({ requestId, action, response });
      navigate("/approvals");
    } catch (err) {
      alert(err instanceof Error ? err.message : "Failed to respond");
    } finally {
      setResponding(false);
    }
  }, [requestId, navigate]);

  if (loading && !overview) return <div style={s.center}><p style={s.gray}>Loading…</p></div>;

  if (!request) return (
    <div style={s.center}>
      <p style={s.gray}>Approval not found — may have been resolved</p>
      <button style={s.btn} onClick={() => navigate("/approvals")}>Back</button>
    </div>
  );

  const isResolved = request.status !== "open";
  const needsReply = request.primaryAction === "reply";

  return (
    <div style={s.page}>
      <div style={s.toolbar}>
        <button style={s.backBtn} onClick={() => navigate("/approvals")}>← Back</button>
        <button style={s.refreshBtn} onClick={refresh}>↻</button>
      </div>
      <div style={s.scroll}>
        {/* Risk banner */}
        <div style={{ ...s.riskBanner, background: riskColor(request.riskLevel) }}>
          {request.riskLevel.toUpperCase()}
        </div>
        <h2 style={s.title}>{request.title}</h2>
        <p style={s.time}>{timeAgo(request.createdAt)}</p>

        {/* Meta */}
        <div style={s.metaGrid}>
          {agent && <MetaRow label="Machine" value={agent.displayName} />}
          {parentJob && <MetaRow label="Session" value={parentJob.title} />}
          {request.eventType && <MetaRow label="Event" value={request.eventType} />}
          <MetaRow label="Status" value={request.status} />
        </div>

        {/* Command */}
        {request.command && (
          <>
            <p style={s.sectionLabel}>Command</p>
            <pre style={s.codeBlock}>{request.command}</pre>
          </>
        )}

        {/* Message */}
        {request.message && (
          <>
            <p style={s.sectionLabel}>Message</p>
            <p style={s.message}>{request.message}</p>
          </>
        )}

        {/* Actions */}
        {isResolved ? (
          <div style={s.resolvedBanner}>
            {request.status === "approved" ? "✓ Approved" : "✗ Rejected"}
            {request.response ? ` — ${request.response}` : ""}
          </div>
        ) : (
          <>
            {needsReply && (
              <>
                <p style={s.sectionLabel}>Reply</p>
                <textarea
                  style={s.replyInput}
                  value={replyText}
                  onChange={(e) => setReplyText(e.target.value)}
                  placeholder="Your reply to the agent…"
                  rows={4}
                  disabled={responding}
                />
              </>
            )}
            <div style={s.actionRow}>
              <button
                style={{ ...s.rejectBtn, opacity: responding ? 0.5 : 1 }}
                onClick={() => handleRespond("reject")}
                disabled={responding}
              >Reject</button>
              <button
                style={{ ...s.approveBtn, opacity: responding ? 0.5 : 1 }}
                onClick={() => handleRespond("approve", needsReply && replyText.trim() ? replyText.trim() : undefined)}
                disabled={responding}
              >{responding ? "…" : needsReply ? "Send Reply" : "Approve"}</button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function MetaRow({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ display: "flex", padding: "6px 0", borderBottom: "1px solid #f0f0f0" }}>
      <span style={{ width: 80, fontSize: 13, color: "#888", fontWeight: 600, flexShrink: 0 }}>{label}</span>
      <span style={{ fontSize: 13, color: "#111" }}>{value}</span>
    </div>
  );
}

const s: Record<string, React.CSSProperties> = {
  page: { flex: 1, display: "flex", flexDirection: "column", overflow: "hidden" },
  toolbar: { padding: "12px 20px", display: "flex", justifyContent: "space-between", alignItems: "center", borderBottom: "1px solid #e0e0e0", background: "#fff" },
  backBtn: { background: "none", border: "none", fontSize: 15, cursor: "pointer", color: "#333", fontWeight: 600 },
  refreshBtn: { background: "none", border: "none", fontSize: 20, cursor: "pointer", color: "#555" },
  scroll: { flex: 1, overflowY: "auto", padding: "20px 24px" },
  riskBanner: { display: "inline-block", borderRadius: 6, padding: "3px 10px", color: "#fff", fontWeight: 700, fontSize: 12, marginBottom: 10 },
  title: { fontSize: 22, fontWeight: 700, marginBottom: 4 },
  time: { fontSize: 13, color: "#888", marginBottom: 16 },
  metaGrid: { background: "#fff", borderRadius: 10, padding: "4px 14px", border: "1px solid #e8e8e8", marginBottom: 20 },
  sectionLabel: { fontSize: 12, fontWeight: 700, color: "#888", textTransform: "uppercase" as const, letterSpacing: 0.5, marginBottom: 6, marginTop: 16 },
  codeBlock: { fontFamily: "monospace", fontSize: 13, background: "#f5f5f5", padding: 12, borderRadius: 8, overflowX: "auto", whiteSpace: "pre-wrap", wordBreak: "break-all" },
  message: { fontSize: 14, color: "#333", lineHeight: 1.6, background: "#fff", padding: 12, borderRadius: 10, border: "1px solid #e8e8e8" },
  replyInput: { width: "100%", padding: "10px", fontSize: 14, border: "1px solid #ccc", borderRadius: 8, marginTop: 8, marginBottom: 16, resize: "vertical" },
  actionRow: { display: "flex", gap: 12, marginTop: 20 },
  rejectBtn: { flex: 1, padding: "12px 0", border: "1.5px solid #f44336", borderRadius: 10, color: "#f44336", background: "none", fontWeight: 700, fontSize: 16, cursor: "pointer" },
  approveBtn: { flex: 1, padding: "12px 0", background: "#000", color: "#fff", border: "none", borderRadius: 10, fontWeight: 700, fontSize: 16, cursor: "pointer" },
  resolvedBanner: { background: "#e8f5e9", borderRadius: 10, padding: 16, marginTop: 16, color: "#2e7d32", fontWeight: 600, fontSize: 15 },
  center: { flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 16 },
  gray: { color: "#888" },
  btn: { padding: "8px 20px", background: "#000", color: "#fff", border: "none", borderRadius: 8, cursor: "pointer", fontWeight: 600 },
};
