import { useState, useCallback } from "react";
import {
  View, Text, ScrollView, TextInput, TouchableOpacity,
  StyleSheet, ActivityIndicator, Alert,
} from "react-native";
import { useLocalSearchParams, router } from "expo-router";
import { useOverview } from "../../../src/hooks/useOverview";
import { getClient } from "../../../src/client";

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

export default function ApprovalDetailScreen() {
  const { id: requestId } = useLocalSearchParams<{ id: string }>();
  const { overview, loading, refresh } = useOverview(5000);
  const [replyText, setReplyText] = useState("");
  const [responding, setResponding] = useState(false);

  const request = overview?.requests.find((r) => r.requestId === requestId);
  const agent = overview?.agents.find((a) => a.agentId === request?.agentId);
  const parentJob = request?.parentJobId
    ? overview?.jobs.find((j) => j.jobId === request.parentJobId)
    : null;

  const handleRespond = useCallback(async (action: "approve" | "reject", response?: string) => {
    if (!requestId) return;
    setResponding(true);
    try {
      const client = await getClient();
      await client.respondToRemoteApproval({ requestId, action, response });
      router.back();
    } catch (err) {
      Alert.alert("Error", err instanceof Error ? err.message : "Failed to respond");
    } finally {
      setResponding(false);
    }
  }, [requestId]);

  if (loading && !overview) {
    return <View style={s.center}><ActivityIndicator size="large" /></View>;
  }

  if (!request) {
    return (
      <View style={s.center}>
        <Text style={s.grayText}>Approval not found — may have been resolved</Text>
        <TouchableOpacity style={s.backBtn} onPress={() => router.back()}>
          <Text style={s.backText}>Go back</Text>
        </TouchableOpacity>
      </View>
    );
  }

  const isResolved = request.status !== "open";
  const needsReply = request.primaryAction === "reply";

  return (
    <ScrollView style={s.scroll} contentContainerStyle={s.container}>
      {/* Risk + title */}
      <View style={[s.riskBanner, { backgroundColor: riskColor(request.riskLevel) }]}>
        <Text style={s.riskLabel}>{request.riskLevel.toUpperCase()}</Text>
      </View>
      <Text style={s.title}>{request.title}</Text>
      <Text style={s.time}>{timeAgo(request.createdAt)}</Text>

      {/* Meta */}
      <View style={s.metaBox}>
        {agent && <MetaRow label="Machine" value={agent.displayName} />}
        {parentJob && <MetaRow label="Session" value={parentJob.title} />}
        {request.eventType && <MetaRow label="Event" value={request.eventType} />}
        <MetaRow label="Status" value={request.status} />
      </View>

      {/* Command */}
      {request.command && (
        <>
          <Text style={s.sectionLabel}>Command</Text>
          <ScrollView horizontal>
            <Text style={s.codeBlock}>{request.command}</Text>
          </ScrollView>
        </>
      )}

      {/* Message */}
      {request.message && (
        <>
          <Text style={s.sectionLabel}>Message</Text>
          <Text style={s.message}>{request.message}</Text>
        </>
      )}

      {/* Response / actions */}
      {isResolved ? (
        <View style={s.resolvedBanner}>
          <Text style={s.resolvedText}>
            {request.status === "approved" ? "✓ Approved" : "✗ Rejected"}
            {request.response ? ` — ${request.response}` : ""}
          </Text>
        </View>
      ) : (
        <>
          {needsReply && (
            <>
              <Text style={s.sectionLabel}>Reply</Text>
              <TextInput
                style={s.replyInput}
                value={replyText}
                onChangeText={setReplyText}
                placeholder="Your reply to the agent…"
                multiline
                editable={!responding}
              />
            </>
          )}
          <View style={s.actionRow}>
            <TouchableOpacity
              style={[s.rejectBtn, responding && s.disabled]}
              onPress={() => handleRespond("reject")}
              disabled={responding}
            >
              <Text style={s.rejectText}>Reject</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[s.approveBtn, responding && s.disabled]}
              onPress={() => handleRespond("approve", needsReply && replyText.trim() ? replyText.trim() : undefined)}
              disabled={responding}
            >
              <Text style={s.approveText}>
                {responding ? "…" : needsReply ? "Send Reply" : "Approve"}
              </Text>
            </TouchableOpacity>
          </View>
        </>
      )}
    </ScrollView>
  );
}

function MetaRow({ label, value }: { label: string; value: string }) {
  return (
    <View style={s.metaRow}>
      <Text style={s.metaLabel}>{label}</Text>
      <Text style={s.metaValue} numberOfLines={1}>{value}</Text>
    </View>
  );
}

const s = StyleSheet.create({
  scroll: { flex: 1, backgroundColor: "#f5f5f5" },
  container: { padding: 16, paddingBottom: 40 },
  center: { flex: 1, justifyContent: "center", alignItems: "center", padding: 32 },
  riskBanner: { borderRadius: 6, alignSelf: "flex-start", paddingHorizontal: 10, paddingVertical: 4, marginBottom: 10 },
  riskLabel: { color: "#fff", fontWeight: "700", fontSize: 12 },
  title: { fontSize: 20, fontWeight: "700", marginBottom: 4 },
  time: { fontSize: 13, color: "#888", marginBottom: 16 },
  metaBox: { backgroundColor: "#fff", borderRadius: 10, padding: 12, marginBottom: 16 },
  metaRow: { flexDirection: "row", paddingVertical: 5, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: "#eee" },
  metaLabel: { width: 72, fontSize: 13, color: "#888", fontWeight: "600" },
  metaValue: { flex: 1, fontSize: 13 },
  sectionLabel: { fontSize: 12, fontWeight: "700", color: "#666", textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 6, marginTop: 4 },
  codeBlock: { fontFamily: "monospace", fontSize: 13, color: "#111", backgroundColor: "#f0f0f0", padding: 12, borderRadius: 8, minWidth: "100%" },
  message: { fontSize: 14, color: "#333", backgroundColor: "#fff", padding: 12, borderRadius: 10, lineHeight: 20 },
  replyInput: { borderWidth: 1, borderColor: "#ccc", borderRadius: 8, padding: 12, fontSize: 14, minHeight: 80, backgroundColor: "#fff", marginBottom: 12 },
  actionRow: { flexDirection: "row", gap: 12, marginTop: 16 },
  rejectBtn: { flex: 1, borderWidth: 1.5, borderColor: "#f44336", borderRadius: 10, padding: 14, alignItems: "center" },
  rejectText: { color: "#f44336", fontWeight: "700", fontSize: 16 },
  approveBtn: { flex: 1, backgroundColor: "#000", borderRadius: 10, padding: 14, alignItems: "center" },
  approveText: { color: "#fff", fontWeight: "700", fontSize: 16 },
  disabled: { opacity: 0.4 },
  resolvedBanner: { backgroundColor: "#e8f5e9", borderRadius: 10, padding: 14, marginTop: 16 },
  resolvedText: { color: "#2e7d32", fontWeight: "600", fontSize: 15 },
  grayText: { color: "#888", textAlign: "center", marginBottom: 16 },
  backBtn: { backgroundColor: "#000", borderRadius: 8, paddingHorizontal: 20, paddingVertical: 10 },
  backText: { color: "#fff", fontWeight: "600" },
});
