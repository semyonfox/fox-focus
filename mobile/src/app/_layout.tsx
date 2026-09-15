import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { StoreProvider } from "@/lib/store";
import { colors } from "@/lib/theme";
import { useAutoUpdate } from "@/lib/updates";

export default function RootLayout() {
  useAutoUpdate();
  return (
    <StoreProvider>
      <StatusBar style="light" />
      <Stack
        screenOptions={{
          headerStyle: { backgroundColor: colors.page },
          headerTintColor: colors.strong,
          headerTitleStyle: { fontSize: 17 },
          headerShadowVisible: false,
          contentStyle: { backgroundColor: colors.page },
        }}
      >
        <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
        <Stack.Screen name="task/[id]" options={{ title: "Task" }} />
        <Stack.Screen name="inbox/[id]" options={{ title: "Inbox" }} />
        <Stack.Screen name="job/[id]" options={{ title: "Hermes" }} />
        <Stack.Screen name="settings" options={{ title: "Settings" }} />
      </Stack>
    </StoreProvider>
  );
}
