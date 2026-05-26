import { useNavigate } from "react-router-dom";
import type { RemoteAgentJob, RemoteApprovalOverview } from "@vi/client-sdk";
import { useOverview } from "../hooks/useOverview";

function statusLabel(job: RemoteAgentJob): string {
  if (job.status === "queued") return "Queued";
  if (job.status === "completed") return "Done";
  if (job.status === "failed") return "Failed";
  const ps = job.providerState?.state;
  if (ps === "waiting_input") return "Waiting Input";
  if (ps === "waiting_approval") return "Waiting Approval";
  if (ps === "blocked") return "Blocked";
  return "Working";
}

function statusColor(job: RemoteAgentJob): string {
  if (job.status === "completed") return "#4caf50";
  if (job.status === "failed") return "#f44336";
  if (job.status === "queued") return "#888";
  const ps = job.providerState?.state;
  if (ps === "waiting_input" || ps === "waiting_approval") return "#ff9800";
  return "#2196f3";
}

function agentName(overview: RemoteApprovalOverview, agentId: string): string {
  return overview.agents.find((a) => a.agentId === agentId)?.displayName ?? agentId.slice(-8);
}

function timeAgo(iso: string): string {
  const s = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

function sortJobs(jobs: RemoteAgentJob[]): RemoteAgentJob[] {
  const order = (j: RemoteAgentJob) => {
    if (j.status === "running") return 0;
    if (j.status === "queued") return 1;
    if (j.status === "failed") return 2;
    return 3;
  };
  return [...jobs].sort((a, b) => order(a) - order(b) || new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
}

export default function Sessions() {
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

  const jobs = overview ? sortJobs(overview.jobs) : [];

  return (
    <div style={s.page}>
      <div style={s.toolbar}>
        <span style={s.pageTitle}>Sessions</span>
        <button style={s.refreshBtn} onClick={refresh} title="Refresh">↻</button>
      </div>
      {loading && !overview && <p style={s.loadingText}>Loading…</p>}
      {!loading && jobs.length === 0 && <p style={s.emptyText}>No sessions</p>}
      <div style={s.list}>
        {jobs.map((job) => (
          <button
            key={job.jobId}
            style={s.card}
            onClick={() => navigate(`/sessions/${job.jobId}`)}
          >
            <div style={s.cardTop}>
              <span style={{ ...s.badge, background: statusColor(job) }}>{statusLabel(job)}</span>
              <span style={s.time}>{timeAgo(job.updatedAt)}</span>
            </div>
            <p style={s.title}>{job.title}</p>
            <p style={s.meta}>
              {overview ? agentName(overview, job.agentId) : ""}
              {job.cwd ? ` · ${job.cwd.split("/").pop() ?? job.cwd}` : ""}
              {job.model ? ` · ${job.model.split("-").slice(0, 3).join("-")}` : ""}
            </p>
          </button>
        ))}
      </div>
    </div>
  );
}

const s: Record<string, React.CSSProperties> = {
  page: { flex: 1, display: "flex", flexDirection: "column", overflow: "hidden" },
  toolbar: { padding: "16px 20px 12px", display: "flex", alignItems: "center", justifyContent: "space-between", borderBottom: "1px solid #e0e0e0", background: "#fff" },
  pageTitle: { fontSize: 18, fontWeight: 700 },
  refreshBtn: { background: "none", border: "none", fontSize: 20, cursor: "pointer", color: "#555", padding: "0 4px" },
  list: { flex: 1, overflowY: "auto", padding: "12px 16px", display: "flex", flexDirection: "column", gap: 10 },
  center: { flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 16 },
  loadingText: { padding: 20, color: "#888", textAlign: "center" },
  emptyText: { padding: 40, color: "#888", textAlign: "center" },
  errorText: { color: "#f44336", textAlign: "center" },
  retryBtn: { padding: "8px 20px", background: "#000", color: "#fff", border: "none", borderRadius: 8, cursor: "pointer", fontWeight: 600 },
  card: { background: "#fff", border: "1px solid #e8e8e8", borderRadius: 10, padding: "14px 16px", textAlign: "left", cursor: "pointer", width: "100%", transition: "box-shadow 0.15s" },
  cardTop: { display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 6 },
  badge: { borderRadius: 4, padding: "2px 8px", color: "#fff", fontSize: 11, fontWeight: 700 },
  time: { color: "#888", fontSize: 12 },
  title: { fontSize: 15, fontWeight: 600, marginBottom: 4, color: "#111" },
  meta: { fontSize: 13, color: "#666" },
};
