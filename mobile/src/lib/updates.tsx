import Constants from "expo-constants";
import * as Updates from "expo-updates";
import { useEffect } from "react";
import { AppState, Platform, StyleSheet, View } from "react-native";
import { Button, T } from "@/components/ui";
import { colors, radius, space } from "./theme";

const native = Platform.OS !== "web";

// check on launch and whenever the app returns to the front; the download applies on restart
export function useAutoUpdate() {
  useEffect(() => {
    if (!native || __DEV__ || !Updates.isEnabled) return;
    const check = () => {
      Updates.checkForUpdateAsync()
        .then(result => (result.isAvailable ? Updates.fetchUpdateAsync() : undefined))
        .catch(() => undefined);
    };
    check();
    const subscription = AppState.addEventListener("change", state => { if (state === "active") check(); });
    return () => subscription.remove();
  }, []);
}

export async function checkNow(): Promise<string> {
  if (!native) return "Updates only run in the Android app";
  if (__DEV__) return "Development build";
  if (!Updates.isEnabled) return "Updates are off in this build";
  const result = await Updates.checkForUpdateAsync();
  if (!result.isAvailable) return "Up to date";
  await Updates.fetchUpdateAsync();
  return "Downloaded, restart to apply";
}

export function buildFacts(): { label: string; value: string }[] {
  const facts = [{ label: "Version", value: Constants.expoConfig?.version ?? "unknown" }];
  if (!native) return facts;
  return [
    ...facts,
    { label: "Runtime", value: Updates.runtimeVersion ?? "none" },
    { label: "Channel", value: Updates.channel ?? "none" },
    { label: "Update", value: Updates.isEmbeddedLaunch ? "built in" : (Updates.updateId ?? "none").slice(0, 8) },
  ];
}

function NativeUpdateBanner() {
  const { isUpdatePending } = Updates.useUpdates();
  if (!isUpdatePending) return null;
  return (
    <View style={styles.banner}>
      <T size="small" tone="strong" style={styles.grow}>Update ready</T>
      <Button label="Restart" tone="primary" onPress={() => { void Updates.reloadAsync(); }} />
    </View>
  );
}

export function UpdateBanner() {
  return native ? <NativeUpdateBanner /> : null;
}

const styles = StyleSheet.create({
  banner: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.sm,
    backgroundColor: colors.blueSoft,
    borderRadius: radius,
    paddingVertical: space.sm,
    paddingHorizontal: space.md,
    marginBottom: space.md,
  },
  grow: { flex: 1 },
});
