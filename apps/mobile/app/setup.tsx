import { useState } from "react";
import {
  View, Text, TextInput, TouchableOpacity, StyleSheet,
  Alert, ScrollView, KeyboardAvoidingView, Platform,
} from "react-native";
import { router } from "expo-router";
import { saveConfig, clearConfig, loadConfig } from "../src/storage";
import { invalidateClient } from "../src/client";

export default function SetupScreen() {
  const [baseUrl, setBaseUrl] = useState("");
  const [token, setToken] = useState("");
  const [saving, setSaving] = useState(false);

  async function handleSave() {
    const url = baseUrl.trim();
    const tok = token.trim();
    if (!url || !tok) {
      Alert.alert("Missing fields", "Both Relay URL and token are required.");
      return;
    }
    if (!url.startsWith("http://") && !url.startsWith("https://")) {
      Alert.alert("Invalid URL", "Relay URL must start with http:// or https://");
      return;
    }
    setSaving(true);
    try {
      await saveConfig({ baseUrl: url, token: tok });
      invalidateClient();
      router.replace("/(tabs)/sessions");
    } catch {
      Alert.alert("Error", "Failed to save config.");
    } finally {
      setSaving(false);
    }
  }

  async function handleClear() {
    Alert.alert("Clear config", "Remove saved relay credentials?", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Clear", style: "destructive",
        onPress: async () => {
          await clearConfig();
          invalidateClient();
          setBaseUrl("");
          setToken("");
        },
      },
    ]);
  }

  // Pre-fill from stored config
  useState(() => {
    loadConfig().then((cfg) => {
      if (cfg) {
        setBaseUrl(cfg.baseUrl);
        // Do not pre-fill the token field — require re-entry
      }
    });
  });

  return (
    <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === "ios" ? "padding" : undefined}>
      <ScrollView contentContainerStyle={s.container} keyboardShouldPersistTaps="handled">
        <Text style={s.heading}>Relay Connection</Text>
        <Text style={s.label}>Relay Base URL</Text>
        <TextInput
          style={s.input}
          value={baseUrl}
          onChangeText={setBaseUrl}
          placeholder="https://relay.example.com"
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="url"
        />
        <Text style={s.label}>VI Token</Text>
        <TextInput
          style={s.input}
          value={token}
          onChangeText={setToken}
          placeholder="Enter your VI token"
          secureTextEntry
          autoCapitalize="none"
          autoCorrect={false}
        />
        <TouchableOpacity style={[s.btn, saving && s.btnDisabled]} onPress={handleSave} disabled={saving}>
          <Text style={s.btnText}>{saving ? "Saving…" : "Save & Connect"}</Text>
        </TouchableOpacity>
        <TouchableOpacity style={s.clearBtn} onPress={handleClear}>
          <Text style={s.clearText}>Clear saved credentials</Text>
        </TouchableOpacity>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const s = StyleSheet.create({
  container: { padding: 24, paddingTop: 32 },
  heading: { fontSize: 22, fontWeight: "700", marginBottom: 28 },
  label: { fontSize: 13, fontWeight: "600", color: "#666", marginBottom: 6, marginTop: 16 },
  input: {
    borderWidth: 1, borderColor: "#ccc", borderRadius: 8,
    padding: 12, fontSize: 15, backgroundColor: "#fff",
  },
  btn: {
    marginTop: 28, backgroundColor: "#000", borderRadius: 8,
    padding: 14, alignItems: "center",
  },
  btnDisabled: { opacity: 0.5 },
  btnText: { color: "#fff", fontWeight: "700", fontSize: 16 },
  clearBtn: { marginTop: 16, alignItems: "center", padding: 8 },
  clearText: { color: "#c00", fontSize: 14 },
});
