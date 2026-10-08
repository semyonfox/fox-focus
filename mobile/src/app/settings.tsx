import { router } from "expo-router";
import { useState } from "react";
import { Actions, Button, Fact, Field, Panel, Screen, Section, T } from "@/components/ui";
import { useStore } from "@/lib/store";
import { buildFacts, checkNow, UpdateBanner } from "@/lib/updates";

export default function Settings() {
  const { connection, connect, notify } = useStore();
  const [baseUrl, setBaseUrl] = useState(connection?.baseUrl ?? "https://focus.semyon.ie");
  // the server's owner login is always "fox"
  const [username, setUsername] = useState(connection?.username ?? "fox");
  const [password, setPassword] = useState(connection?.password ?? "");
  const [busy, setBusy] = useState(false);
  const [connectionError, setConnectionError] = useState<string | null>(null);
  const [updateStatus, setUpdateStatus] = useState<string | null>(null);

  const save = async () => {
    setConnectionError(null);
    setBusy(true);
    try {
      await connect({ baseUrl: baseUrl.trim().replace(/\/+$/, ""), username: username.trim(), password });
      notify("Connected");
      router.back();
    } catch (cause) {
      setConnectionError(cause instanceof Error ? cause.message : "Could not connect");
    } finally {
      setBusy(false);
    }
  };

  const check = async () => {
    setUpdateStatus("Checking");
    try {
      setUpdateStatus(await checkNow());
    } catch (cause) {
      setUpdateStatus(cause instanceof Error ? cause.message : "Update check failed");
    }
  };

  return (
    <Screen>
      <Section title="Server" />
      <Field label="Server URL" value={baseUrl} onChangeText={setBaseUrl} placeholder="https://focus.semyon.ie" autoCapitalize="none" autoCorrect={false} keyboardType="url" />
      <Field label="Username" value={username} onChangeText={setUsername} placeholder="Username" autoCapitalize="none" autoCorrect={false} />
      <Field label="Password" value={password} onChangeText={setPassword} placeholder="Password" secureTextEntry />
      {connectionError ? <T tone="amber" accessibilityRole="alert" accessibilityLiveRegion="polite">{connectionError}</T> : null}
      <Actions>
        <Button
          label={busy ? "Connecting" : connection ? "Save" : "Connect"}
          tone="primary"
          disabled={busy || !baseUrl.trim() || !username.trim() || !password}
          onPress={() => { void save(); }}
        />
        {connection ? <Button label="Sign out" tone="quiet" disabled={busy} onPress={() => {
          setConnectionError(null); setBusy(true);
          void connect(null).catch(cause => setConnectionError(cause instanceof Error ? cause.message : "Could not sign out")).finally(() => setBusy(false));
        }} /> : null}
      </Actions>

      <Section title="App" />
      <UpdateBanner />
      <Panel>{buildFacts().map(fact => <Fact key={fact.label} label={fact.label} value={fact.value} />)}</Panel>
      <Actions>
        <Button label="Check for update" onPress={() => { void check(); }} />
      </Actions>
      {updateStatus ? <T size="small" tone="faint" style={{ marginTop: 8 }}>{updateStatus}</T> : null}
    </Screen>
  );
}
