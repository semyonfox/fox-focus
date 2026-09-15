import { router, Tabs } from "expo-router";
import { Pressable, Text } from "react-native";
import { needsCount } from "@/lib/derive";
import { useStore } from "@/lib/store";
import { colors, font, space } from "@/lib/theme";

function SettingsLink() {
  return (
    <Pressable onPress={() => router.push("/settings")} hitSlop={8} style={{ paddingHorizontal: space.lg }}>
      <Text style={{ color: colors.muted, fontSize: font.small }}>Settings</Text>
    </Pressable>
  );
}

export default function TabsLayout() {
  const { rows } = useStore();
  const needs = needsCount(rows);
  return (
    <Tabs
      screenOptions={{
        headerStyle: { backgroundColor: colors.page },
        headerTintColor: colors.strong,
        headerTitleStyle: { fontSize: 17 },
        headerShadowVisible: false,
        headerRight: () => <SettingsLink />,
        sceneStyle: { backgroundColor: colors.page },
        tabBarStyle: { backgroundColor: colors.page, borderTopColor: colors.line },
        tabBarActiveTintColor: colors.strong,
        tabBarInactiveTintColor: colors.faint,
        tabBarIconStyle: { display: "none" },
        tabBarLabelStyle: { fontSize: font.small, fontWeight: "500" },
        tabBarLabelPosition: "beside-icon",
      }}
    >
      <Tabs.Screen name="index" options={{ title: "Today" }} />
      <Tabs.Screen name="tasks" options={{ title: "Tasks" }} />
      <Tabs.Screen
        name="inbox"
        options={{
          title: "Inbox",
          tabBarBadge: needs || undefined,
          tabBarBadgeStyle: { backgroundColor: colors.amber, color: colors.page, fontSize: font.tiny },
        }}
      />
    </Tabs>
  );
}
