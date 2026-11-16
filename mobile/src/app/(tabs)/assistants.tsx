import { createJob } from "@shared/inbox-client";
import type { AssistantId } from "@shared/row-model";
import { assistantCapabilities, isRoutineMirror, relativeTime, routineField } from "@shared/work-threads";
import { useState } from "react";
import { StyleSheet, View } from "react-native";
import { DockScene } from "@/components/dock";
import { ThreadItem } from "@/components/rows";
import { ConnectPrompt } from "@/components/status-line";
import { Button, Chip, Composer, Panel, Screen, Section, T } from "@/components/ui";
import { randomKey } from "@/lib/api";
import { threads, threadTitleFrom } from "@/lib/derive";
import { useStore } from "@/lib/store";
import { colors, space } from "@/lib/theme";

const levelLabel = { allowed: "allowed", asks: "asks you", never: "never" } as const;

export default function Assistants() {
  const { rows, run, connection, ready, loadedAt } = useStore();
  const [selected, setSelected] = useState<AssistantId>("fox");
  const [composing, setComposing] = useState(false);
  const [showSettled, setShowSettled] = useState(false);

  if (ready && !connection) {
    return <DockScene tab="assistants"><Screen><ConnectPrompt /></Screen></DockScene>;
  }

  const roster = rows.capabilities.assistants;
  const assistant = roster.find(candidate => candidate.id === selected) ?? roster[0];
  if (!assistant) {
    return (
      <DockScene tab="assistants">
        <Screen><T size="small" tone="faint">{loadedAt ? "No assistants on this server" : "Loading assistants…"}</T></Screen>
      </DockScene>
    );
  }

  const all = threads(rows);
  const own = all.filter(thread => thread.assistant === assistant.id && thread.kind === "job" && thread.job && !thread.item)
    .sort((first, second) => second.updatedAt.localeCompare(first.updatedAt));
  const open = own.filter(thread => thread.shelf !== "settled");
  const settled = own.filter(thread => thread.shelf === "settled");
  const routines = assistant.id === "hermes" ? rows.inbox.filter(isRoutineMirror) : [];

  const summary = (id: AssistantId) => {
    const mine = all.filter(thread => thread.assistant === id && thread.shelf === "active");
    const needs = mine.filter(thread => thread.attention).length;
    const working = mine.filter(thread => thread.tone === "working").length;
    return [needs ? `${needs} need${needs === 1 ? "s" : ""} you` : "", working ? `${working} working` : ""].filter(Boolean).join(" · ") || "All quiet";
  };

  const start = async (text: string) => {
    const ok = await run(() => createJob({ idempotencyKey: randomKey(), title: threadTitleFrom(text), instruction: text, assistant: assistant.id }),
      assistant.id === "fox" ? "Sent to Fox" : "Queued for Hermes");
    if (ok) setComposing(false);
    return ok;
  };

  return (
    <DockScene tab="assistants">
      <Screen>
        <View style={styles.chips}>
          {roster.map(candidate => (
            <Chip key={candidate.id} label={candidate.name} on={candidate.id === assistant.id} onPress={() => { setSelected(candidate.id); setComposing(false); }} />
          ))}
        </View>
        <Panel>
          <T bold>{`${assistant.name} · ${assistant.engine === "claude" ? "Claude" : "Hermes"}`}</T>
          <T size="small" tone="muted">{assistant.available ? `${assistant.role} · ${summary(assistant.id)}` : "Not configured on this server"}</T>
        </Panel>

        {composing ? (
          <Composer
            label={`Message ${assistant.name}`}
            placeholder={assistant.id === "fox" ? "Ask Fox anything" : "Hand Hermes a request"}
            submitLabel="Send"
            onSubmit={start}
            onCancel={() => setComposing(false)}
          />
        ) : (
          <View style={styles.start}>
            <Button label="New thread" tone="primary" disabled={!assistant.available} onPress={() => setComposing(true)} />
          </View>
        )}

        <Section title="Threads" count={open.length} />
        {open.length ? open.map(thread => <ThreadItem key={thread.key} thread={thread} />) : <T size="small" tone="faint">No open threads</T>}
        {settled.length ? (
          <>
            <Section title="Settled" count={settled.length} action={<Button label={showSettled ? "Hide" : "Show"} tone="quiet" onPress={() => setShowSettled(current => !current)} />} />
            {showSettled ? settled.slice(0, 30).map(thread => <ThreadItem key={thread.key} thread={thread} />) : null}
          </>
        ) : null}

        {assistant.id === "hermes" ? (
          <>
            <Section title="Routines" count={routines.length} />
            {routines.length ? routines.map(routine => {
              const enabled = routineField(routine.summary, "Enabled");
              const lastRun = routineField(routine.summary, "Last run");
              const state = enabled === "False" ? "off" : lastRun && lastRun !== "ok" && lastRun !== "never run" ? "bad" : "ok";
              const meta = [routineField(routine.summary, "Schedule"), enabled === "False" ? "paused" : lastRun ? `last run ${lastRun}` : null, relativeTime(routine.updatedAt)]
                .filter(Boolean).join(" · ");
              return (
                <View key={routine.id} style={styles.row}>
                  <View style={[styles.dot, { backgroundColor: state === "bad" ? colors.amber : state === "off" ? colors.faint : colors.blue }]} />
                  <View style={styles.grow}>
                    <T numberOfLines={1}>{routine.title.replace(/^Hermes: /, "")}</T>
                    <T size="small" tone={state === "bad" ? "amber" : "faint"} numberOfLines={1}>{meta}</T>
                  </View>
                </View>
              );
            }) : <T size="small" tone="faint">No routines reported</T>}
          </>
        ) : null}

        <Section title="Can do" />
        {assistantCapabilities[assistant.id].map(capability => (
          <View key={capability.label} style={styles.row}>
            <T size="small" style={styles.grow}>{capability.label}</T>
            <T size="small" tone={capability.level === "never" ? "faint" : capability.level === "asks" ? "amber" : "blue"}>{levelLabel[capability.level]}</T>
          </View>
        ))}
      </Screen>
    </DockScene>
  );
}

const styles = StyleSheet.create({
  chips: { flexDirection: "row", gap: space.sm },
  start: { marginTop: space.md, alignItems: "flex-start" },
  row: {
    flexDirection: "row", alignItems: "center", gap: space.md, paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.lineSoft,
  },
  dot: { width: 8, height: 8, borderRadius: 4 },
  grow: { flex: 1 },
});
