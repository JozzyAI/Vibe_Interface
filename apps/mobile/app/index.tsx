import { useEffect, useState } from "react";
import { View, ActivityIndicator } from "react-native";
import { Redirect } from "expo-router";
import { loadConfig } from "../src/storage";

export default function BootScreen() {
  const [ready, setReady] = useState(false);
  const [hasConfig, setHasConfig] = useState(false);

  useEffect(() => {
    loadConfig().then((cfg) => {
      setHasConfig(cfg !== null);
      setReady(true);
    });
  }, []);

  if (!ready) {
    return (
      <View style={{ flex: 1, justifyContent: "center", alignItems: "center" }}>
        <ActivityIndicator size="large" />
      </View>
    );
  }

  return <Redirect href={hasConfig ? "/(tabs)/sessions" : "/setup"} />;
}
