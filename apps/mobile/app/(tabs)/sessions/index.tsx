import { View, Text, FlatList, TouchableOpacity, StyleSheet, RefreshControl } from "react-native";
import { router } from "expo-router";
import { useOverview } from "../../../src/hooks/useOverview";
import type { RemoteAgentJob, RemoteApprovalOverview } from "@vi/client-sdk";

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

export default function SessionsScreen() {
  const { overview, loading, error, refresh } = useOverview(5000);

  if (error && !overview) {
    return (
      <View style={s.center}>
        <Text style={s.errorText}>{error}</Text>
        <TouchableOpacity style={s.retryBtn} onPress={refresh}>
          <Text style={s.retryText}>Retry</Text>
        </TouchableOpacity>
      </View>
    );
  }

  const jobs = overview ? sortJobs(overview.jobs) : [];

  return (
    <FlatList
      data={jobs}
      keyExtractor={(j) => j.jobId}
      refreshControl={<RefreshControl refreshing={loading && !overview} onRefresh={refresh} />}
      ListEmptyComponent={
        !loading ? (
          <View style={s.center}>
            <Text style={s.emptyText}>No sessions</Text>
          </View>
        ) : null
      }
      renderItem={({ item: job }) => (
        <TouchableOpacity style={s.card} onPress={() => router.push(`/sessions/${job.jobId}`)}>
          <View style={s.cardHeader}>
            <View style={[s.badge, { backgroundColor: statusColor(job) }]}>
              <Text style={s.badgeText}>{statusLabel(job)}</Text>
            </View>
            <Text style={s.time}>{timeAgo(job.updatedAt)}</Text>
          </View>
          <Text style={s.title} numberOfLines={2}>{job.title}</Text>
          <Text style={s.meta}>
            {overview ? agentName(overview, job.agentId) : ""}
            {job.cwd ? ` · ${job.cwd.split("/").pop() ?? job.cwd}` : ""}
            {job.model ? ` · ${job.model.split("-").slice(0, 3).join("-")}` : ""}
          </Text>
        </TouchableOpacity>
      )}
      contentContainerStyle={jobs.length === 0 ? { flex: 1 } : { paddingBottom: 16 }}
    />
  );
}

const s = StyleSheet.create({
  center: { flex: 1, justifyContent: "center", alignItems: "center", padding: 32 },
  errorText: { color: "#f44336", textAlign: "center", marginBottom: 16, fontSize: 15 },
  emptyText: { color: "#888", fontSize: 16 },
  retryBtn: { backgroundColor: "#000", borderRadius: 8, paddingHorizontal: 20, paddingVertical: 10 },
  retryText: { color: "#fff", fontWeight: "600" },
  card: {
    margin: 12, marginBottom: 0, padding: 14,
    backgroundColor: "#fff", borderRadius: 10,
    shadowColor: "#000", shadowOpacity: 0.07, shadowRadius: 4, shadowOffset: { width: 0, height: 1 },
    elevation: 2,
  },
  cardHeader: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginBottom: 6 },
  badge: { borderRadius: 4, paddingHorizontal: 7, paddingVertical: 2 },
  badgeText: { color: "#fff", fontSize: 11, fontWeight: "700" },
  time: { color: "#888", fontSize: 12 },
  title: { fontSize: 15, fontWeight: "600", marginBottom: 4 },
  meta: { fontSize: 13, color: "#666" },
});
