import { router, Tabs } from "expo-router";
import { Pressable, Text } from "react-native";
import { Dock } from "@/components/dock";
import { DockProvider } from "@/lib/dock";
import { colors, font, space } from "@/lib/theme";

function SettingsLink() {
  return (
    <Pressable onPress={() => router.push("/settings")} hitSlop={8} style={{ paddingHorizontal: space.lg }}>
      <Text style={{ color: colors.muted, fontSize: font.small }}>Settings</Text>
    </Pressable>
  );
}

export default function TabsLayout() {
  return (
    <DockProvider>
      <Tabs
        tabBar={(props) => <Dock {...props} />}
        screenOptions={{
          headerStyle: { backgroundColor: colors.page },
          headerTintColor: colors.strong,
          headerTitleStyle: { fontSize: 17 },
          headerShadowVisible: false,
          headerRight: () => <SettingsLink />,
          sceneStyle: { backgroundColor: colors.page },
        }}
      >
        <Tabs.Screen name="index" options={{ title: "Today" }} />
        <Tabs.Screen name="tasks" options={{ title: "Tasks" }} />
        <Tabs.Screen name="inbox" options={{ title: "Inbox" }} />
      </Tabs>
    </DockProvider>
  );
}
