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
  const [updateStatus, setUpdateStatus] = useState<string | null>(null);

  const save = async () => {
    setBusy(true);
    try {
      await connect({ baseUrl: baseUrl.trim().replace(/\/+$/, ""), username: username.trim(), password });
      notify("Connected");
      router.back();
    } catch (cause) {
      notify(cause instanceof Error ? cause.message : "Could not connect");
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
      <Field value={baseUrl} onChangeText={setBaseUrl} placeholder="https://focus.semyon.ie" autoCapitalize="none" autoCorrect={false} keyboardType="url" />
      <Field value={username} onChangeText={setUsername} placeholder="Username" autoCapitalize="none" autoCorrect={false} />
      <Field value={password} onChangeText={setPassword} placeholder="Password" secureTextEntry />
      <Actions>
        <Button
          label={busy ? "Connecting" : connection ? "Save" : "Connect"}
          tone="primary"
          disabled={busy || !baseUrl.trim() || !username.trim() || !password}
          onPress={() => { void save(); }}
        />
        {connection ? <Button label="Sign out" tone="quiet" onPress={() => { void connect(null); }} /> : null}
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
