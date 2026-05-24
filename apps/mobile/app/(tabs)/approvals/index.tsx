import { View, Text, FlatList, TouchableOpacity, StyleSheet, RefreshControl } from "react-native";
import { router } from "expo-router";
import { useOverview } from "../../../src/hooks/useOverview";
import type { RemoteApprovalOverview, RemoteApprovalRequest } from "@vi/client-sdk";

function riskColor(r: string): string {
  if (r === "critical") return "#b71c1c";
  if (r === "high") return "#f44336";
  if (r === "medium") return "#ff9800";
  return "#4caf50";
}

function agentName(overview: RemoteApprovalOverview, agentId: string): string {
  return overview.agents.find((a) => a.agentId === agentId)?.displayName ?? agentId.slice(-8);
}

function timeAgo(iso: string): string {
  const s = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  return `${Math.floor(s / 3600)}h ago`;
}

function ApprovalRow({ req, overview }: { req: RemoteApprovalRequest; overview: RemoteApprovalOverview }) {
  return (
    <TouchableOpacity style={s.card} onPress={() => router.push(`/approvals/${req.requestId}`)}>
      <View style={s.cardHeader}>
        <View style={[s.badge, { backgroundColor: riskColor(req.riskLevel) }]}>
          <Text style={s.badgeText}>{req.riskLevel.toUpperCase()}</Text>
        </View>
        <Text style={s.time}>{timeAgo(req.createdAt)}</Text>
      </View>
      <Text style={s.title} numberOfLines={2}>{req.title}</Text>
      {req.command && <Text style={s.command} numberOfLines={1}>{req.command}</Text>}
      <Text style={s.meta}>{agentName(overview, req.agentId)}</Text>
    </TouchableOpacity>
  );
}

export default function ApprovalsScreen() {
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

  const pending = overview?.requests.filter((r) => r.status === "open") ?? [];
  pending.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

  return (
    <FlatList
      data={pending}
      keyExtractor={(r) => r.requestId}
      refreshControl={<RefreshControl refreshing={loading && !overview} onRefresh={refresh} />}
      ListEmptyComponent={
        !loading ? (
          <View style={s.center}>
            <Text style={s.emptyText}>No pending approvals</Text>
          </View>
        ) : null
      }
      renderItem={({ item }) => overview ? <ApprovalRow req={item} overview={overview} /> : null}
      contentContainerStyle={pending.length === 0 ? { flex: 1 } : { paddingBottom: 16 }}
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
  command: { fontFamily: "monospace", fontSize: 12, color: "#444", marginBottom: 4 },
  meta: { fontSize: 13, color: "#666" },
});
