import { Tabs } from "expo-router";

export default function TabLayout() {
  return (
    <Tabs screenOptions={{ tabBarActiveTintColor: "#000" }}>
      <Tabs.Screen
        name="sessions"
        options={{ title: "Sessions", tabBarLabel: "Sessions" }}
      />
      <Tabs.Screen
        name="approvals"
        options={{ title: "Approvals", tabBarLabel: "Approvals" }}
      />
    </Tabs>
  );
}
