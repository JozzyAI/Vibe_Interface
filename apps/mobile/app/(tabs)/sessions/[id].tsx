import { useState, useCallback } from "react";
import {
  View, Text, ScrollView, TextInput, TouchableOpacity,
  StyleSheet, ActivityIndicator, Alert,
} from "react-native";
import { useLocalSearchParams, router } from "expo-router";
import { useOverview } from "../../../src/hooks/useOverview";
import { getClient } from "../../../src/client";
import type { RemoteApprovalRequest } from "@vi/client-sdk";

function riskColor(r: string): string {
  if (r === "critical") return "#b71c1c";
  if (r === "high") return "#f44336";
  if (r === "medium") return "#ff9800";
  return "#4caf50";
}

export default function SessionDetailScreen() {
  const { id: jobId } = useLocalSearchParams<{ id: string }>();
  const { overview, loading, error, refresh } = useOverview(3000);

  const [inputText, setInputText] = useState("");
  const [sendingInput, setSendingInput] = useState(false);
  const [respondingTo, setRespondingTo] = useState<string | null>(null);
  const [replyText, setReplyText] = useState("");

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
      Alert.alert("Error", err instanceof Error ? err.message : "Failed to send input");
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
      setReplyText("");
      refresh();
    } catch (err) {
      Alert.alert("Error", err instanceof Error ? err.message : "Failed to respond");
    } finally {
      setRespondingTo(null);
    }
  }, [refresh]);

  if (loading && !overview) {
    return <View style={s.center}><ActivityIndicator size="large" /></View>;
  }

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

  if (!job) {
    return (
      <View style={s.center}>
        <Text style={s.errorText}>Session not found</Text>
        <TouchableOpacity onPress={() => router.back()}>
          <Text style={s.retryText}>Go back</Text>
        </TouchableOpacity>
      </View>
    );
  }

  const canSendInput = job.status === "running" || job.status === "queued";
  const logLines = job.logTail?.split("\n").slice(-30).join("\n") ?? "";

  return (
    <ScrollView style={s.scroll} contentContainerStyle={s.container}>
      {/* Header */}
      <Text style={s.title}>{job.title}</Text>
      <View style={s.metaGrid}>
        {agent && <MetaRow label="Machine" value={agent.displayName} />}
        {job.cwd && <MetaRow label="CWD" value={job.cwd} />}
        {job.model && <MetaRow label="Model" value={job.model} />}
        <MetaRow label="Status" value={job.status} />
        {job.providerState && (
          <MetaRow label="State" value={`${job.providerState.state} (${job.providerState.reason ?? ""})`} />
        )}
      </View>

      {/* Log tail */}
      {logLines ? (
        <Section title="Recent Output">
          <ScrollView horizontal>
            <Text style={s.logText}>{logLines}</Text>
          </ScrollView>
        </Section>
      ) : null}

      {/* Pending approvals */}
      {approvals.length > 0 && (
        <Section title={`Pending Approvals (${approvals.length})`}>
          {approvals.map((req) => (
            <View key={req.requestId} style={s.approvalCard}>
              <View style={s.approvalHeader}>
                <View style={[s.riskBadge, { backgroundColor: riskColor(req.riskLevel) }]}>
                  <Text style={s.riskText}>{req.riskLevel.toUpperCase()}</Text>
                </View>
                <Text style={s.approvalTitle} numberOfLines={2}>{req.title}</Text>
              </View>
              {req.command && <Text style={s.command}>{req.command}</Text>}
              <Text style={s.message} numberOfLines={4}>{req.message}</Text>
              {req.primaryAction === "reply" ? (
                <>
                  <TextInput
                    style={s.replyInput}
                    value={replyText}
                    onChangeText={setReplyText}
                    placeholder="Your reply…"
                    multiline
                  />
                  <View style={s.actionRow}>
                    <TouchableOpacity
                      style={[s.rejectBtn, respondingTo === req.requestId && s.disabled]}
                      onPress={() => handleRespond(req, "reject")}
                      disabled={respondingTo === req.requestId}
                    >
                      <Text style={s.rejectText}>Reject</Text>
                    </TouchableOpacity>
                    <TouchableOpacity
                      style={[s.approveBtn, respondingTo === req.requestId && s.disabled]}
                      onPress={() => handleRespond(req, "approve", replyText.trim() || undefined)}
                      disabled={respondingTo === req.requestId}
                    >
                      <Text style={s.approveText}>{respondingTo === req.requestId ? "…" : "Send Reply"}</Text>
                    </TouchableOpacity>
                  </View>
                </>
              ) : (
                <View style={s.actionRow}>
                  <TouchableOpacity
                    style={[s.rejectBtn, respondingTo === req.requestId && s.disabled]}
                    onPress={() => handleRespond(req, "reject")}
                    disabled={respondingTo === req.requestId}
                  >
                    <Text style={s.rejectText}>Reject</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={[s.approveBtn, respondingTo === req.requestId && s.disabled]}
                    onPress={() => handleRespond(req, "approve")}
                    disabled={respondingTo === req.requestId}
                  >
                    <Text style={s.approveText}>{respondingTo === req.requestId ? "…" : "Approve"}</Text>
                  </TouchableOpacity>
                </View>
              )}
            </View>
          ))}
        </Section>
      )}

      {/* Send input — stored in relay, delivered to vi-agent on next poll. */}
      {canSendInput && (
        <Section title="Send Input">
          <Text style={s.partialNote}>
            Input is sent to the running session through VI Relay.
          </Text>
          <View style={s.inputRow}>
            <TextInput
              style={s.textInput}
              value={inputText}
              onChangeText={setInputText}
              placeholder="Type input for the agent…"
              multiline
              returnKeyType="default"
            />
            <TouchableOpacity
              style={[s.sendBtn, (!inputText.trim() || sendingInput) && s.disabled]}
              onPress={handleSendInput}
              disabled={!inputText.trim() || sendingInput}
            >
              <Text style={s.sendText}>{sendingInput ? "…" : "Send"}</Text>
            </TouchableOpacity>
          </View>
        </Section>
      )}
    </ScrollView>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <View style={s.section}>
      <Text style={s.sectionTitle}>{title}</Text>
      {children}
    </View>
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
  title: { fontSize: 20, fontWeight: "700", marginBottom: 12 },
  metaGrid: { backgroundColor: "#fff", borderRadius: 10, padding: 12, marginBottom: 4 },
  metaRow: { flexDirection: "row", paddingVertical: 5, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: "#eee" },
  metaLabel: { width: 72, fontSize: 13, color: "#888", fontWeight: "600" },
  metaValue: { flex: 1, fontSize: 13 },
  section: { marginTop: 16 },
  sectionTitle: { fontSize: 13, fontWeight: "700", color: "#666", marginBottom: 8, textTransform: "uppercase", letterSpacing: 0.5 },
  logText: { fontFamily: "monospace", fontSize: 12, color: "#222", lineHeight: 18, minWidth: "100%" },
  partialNote: { fontSize: 12, color: "#e65100", marginBottom: 8, fontStyle: "italic" },
  approvalCard: { backgroundColor: "#fff", borderRadius: 10, padding: 14, marginBottom: 10 },
  approvalHeader: { flexDirection: "row", alignItems: "flex-start", marginBottom: 8, gap: 8 },
  riskBadge: { borderRadius: 4, paddingHorizontal: 6, paddingVertical: 2, alignSelf: "flex-start" },
  riskText: { color: "#fff", fontSize: 10, fontWeight: "700" },
  approvalTitle: { flex: 1, fontSize: 14, fontWeight: "600" },
  command: { fontFamily: "monospace", fontSize: 12, backgroundColor: "#f0f0f0", padding: 8, borderRadius: 6, marginBottom: 8 },
  message: { fontSize: 13, color: "#444", marginBottom: 12 },
  replyInput: { borderWidth: 1, borderColor: "#ccc", borderRadius: 8, padding: 10, fontSize: 14, minHeight: 60, marginBottom: 10 },
  actionRow: { flexDirection: "row", gap: 10 },
  rejectBtn: { flex: 1, borderWidth: 1, borderColor: "#f44336", borderRadius: 8, padding: 10, alignItems: "center" },
  rejectText: { color: "#f44336", fontWeight: "700" },
  approveBtn: { flex: 1, backgroundColor: "#000", borderRadius: 8, padding: 10, alignItems: "center" },
  approveText: { color: "#fff", fontWeight: "700" },
  inputRow: { flexDirection: "row", gap: 10, alignItems: "flex-end" },
  textInput: { flex: 1, borderWidth: 1, borderColor: "#ccc", borderRadius: 8, padding: 10, fontSize: 14, minHeight: 44, backgroundColor: "#fff" },
  sendBtn: { backgroundColor: "#000", borderRadius: 8, paddingHorizontal: 16, paddingVertical: 12 },
  sendText: { color: "#fff", fontWeight: "700" },
  disabled: { opacity: 0.4 },
  errorText: { color: "#f44336", textAlign: "center", marginBottom: 16, fontSize: 15 },
  retryBtn: { backgroundColor: "#000", borderRadius: 8, paddingHorizontal: 20, paddingVertical: 10 },
  retryText: { color: "#fff", fontWeight: "600" },
});
