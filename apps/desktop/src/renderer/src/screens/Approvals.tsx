import { useNavigate } from "react-router-dom";
import type { RemoteApprovalRequest, RemoteApprovalOverview } from "@vi/client-sdk";
import { useOverview } from "../hooks/useOverview";

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

function agentName(overview: RemoteApprovalOverview, agentId: string): string {
  return overview.agents.find((a) => a.agentId === agentId)?.displayName ?? agentId.slice(-8);
}

function ApprovalRow({ req, overview, onClick }: { req: RemoteApprovalRequest; overview: RemoteApprovalOverview; onClick: () => void }) {
  return (
    <button style={s.card} onClick={onClick}>
      <div style={s.cardTop}>
        <span style={{ ...s.badge, background: riskColor(req.riskLevel) }}>{req.riskLevel.toUpperCase()}</span>
        <span style={s.time}>{timeAgo(req.createdAt)}</span>
      </div>
      <p style={s.title}>{req.title}</p>
      {req.command && <p style={s.command}>{req.command}</p>}
      <p style={s.meta}>{agentName(overview, req.agentId)}</p>
    </button>
  );
}

export default function Approvals() {
  const navigate = useNavigate();
  const { overview, loading, error, refresh } = useOverview(5000);

  if (error && !overview) {
    return (
      <div style={s.center}>
        <p style={s.errorText}>{error}</p>
        <button style={s.retryBtn} onClick={refresh}>Retry</button>
      </div>
    );
  }

  const pending = [...(overview?.requests.filter((r) => r.status === "open") ?? [])].sort(
    (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
  );

  return (
    <div style={s.page}>
      <div style={s.toolbar}>
        <span style={s.pageTitle}>
          Approvals{pending.length > 0 ? ` (${pending.length})` : ""}
        </span>
        <button style={s.refreshBtn} onClick={refresh} title="Refresh">↻</button>
      </div>
      {loading && !overview && <p style={s.loadingText}>Loading…</p>}
      {!loading && pending.length === 0 && <p style={s.emptyText}>No pending approvals</p>}
      <div style={s.list}>
        {overview && pending.map((req) => (
          <ApprovalRow
            key={req.requestId}
            req={req}
            overview={overview}
            onClick={() => navigate(`/approvals/${req.requestId}`)}
          />
        ))}
      </div>
    </div>
  );
}

const s: Record<string, React.CSSProperties> = {
  page: { flex: 1, display: "flex", flexDirection: "column", overflow: "hidden" },
  toolbar: { padding: "16px 20px 12px", display: "flex", alignItems: "center", justifyContent: "space-between", borderBottom: "1px solid #e0e0e0", background: "#fff" },
  pageTitle: { fontSize: 18, fontWeight: 700 },
  refreshBtn: { background: "none", border: "none", fontSize: 20, cursor: "pointer", color: "#555" },
  list: { flex: 1, overflowY: "auto", padding: "12px 16px", display: "flex", flexDirection: "column", gap: 10 },
  center: { flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 16 },
  loadingText: { padding: 20, color: "#888", textAlign: "center" },
  emptyText: { padding: 40, color: "#888", textAlign: "center" },
  errorText: { color: "#f44336" },
  retryBtn: { padding: "8px 20px", background: "#000", color: "#fff", border: "none", borderRadius: 8, cursor: "pointer", fontWeight: 600 },
  card: { background: "#fff", border: "1px solid #e8e8e8", borderRadius: 10, padding: "14px 16px", textAlign: "left", cursor: "pointer", width: "100%" },
  cardTop: { display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 6 },
  badge: { borderRadius: 4, padding: "2px 8px", color: "#fff", fontSize: 11, fontWeight: 700 },
  time: { color: "#888", fontSize: 12 },
  title: { fontSize: 15, fontWeight: 600, marginBottom: 4, color: "#111" },
  command: { fontFamily: "monospace", fontSize: 12, color: "#555", marginBottom: 4, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
  meta: { fontSize: 13, color: "#666" },
};
