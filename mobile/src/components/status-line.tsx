import { relativeTime } from "@shared/work-threads";
import { router } from "expo-router";
import { StyleSheet, View } from "react-native";
import { useStore } from "@/lib/store";
import { colors, space } from "@/lib/theme";
import { Button, T } from "./ui";

export function StatusLine() {
  const { connection, error, loadedAt, rows } = useStore();
  let text: string;
  let tone: "faint" | "amber" = "faint";
  if (error) { text = error; tone = "amber"; }
  else if (rows.failedScopes.length) { text = `Sync issue: ${rows.failedScopes.join(", ")}`; tone = "amber"; }
  else text = loadedAt ? `Synced ${relativeTime(loadedAt)}` : connection ? "Syncing" : "Not connected";
  return (
    <View style={styles.line}>
      <View style={[styles.pip, { backgroundColor: tone === "amber" ? colors.amber : colors.blue }]} />
      <T size="small" tone={tone} numberOfLines={1}>{text}</T>
    </View>
  );
}

export function ConnectPrompt() {
  return (
    <View style={styles.prompt}>
      <T tone="muted">Not connected</T>
      <Button label="Settings" tone="primary" onPress={() => router.push("/settings")} />
    </View>
  );
}

const styles = StyleSheet.create({
  line: { flexDirection: "row", alignItems: "center", gap: space.sm },
  pip: { width: 6, height: 6, borderRadius: 3 },
  prompt: { alignItems: "flex-start", gap: space.md, marginTop: space.xl },
});
