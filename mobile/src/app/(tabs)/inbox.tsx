import { createJob } from "@shared/inbox-client";
import type { AssistantId } from "@shared/row-model";
import { assistantName, type WorkThreadShelf } from "@shared/work-threads";
import { useState } from "react";
import { Pressable, RefreshControl, SectionList, StyleSheet, View } from "react-native";
import { ThreadItem } from "@/components/rows";
import { DockScene } from "@/components/dock";
import { ConnectPrompt } from "@/components/status-line";
import { Button, Chip, Composer, Section, T } from "@/components/ui";
import { randomKey } from "@/lib/api";
import { assistantAvailable, defaultAssistant, threads, threadTitleFrom } from "@/lib/derive";
import { useDock } from "@/lib/dock";
import { useStore } from "@/lib/store";
import { colors, space } from "@/lib/theme";

// the web sidebar's shelves: active threads, then the collapsed ones
const titles: Record<WorkThreadShelf, string> = { active: "Active", snoozed: "Snoozed", settled: "Settled", noise: "Likely noise" };

type Collapsible = Exclude<WorkThreadShelf, "active">;
type Filter = AssistantId | "all";

export default function Inbox() {
  const { rows, run, loading, refresh, connection, ready, actionError, error, loadedAt } = useStore();
  const dock = useDock();
  const [composing, setComposing] = useState(false);
  const [filter, setFilter] = useState<Filter>("all");
  const [to, setTo] = useState<AssistantId | null>(null);
  const [expanded, setExpanded] = useState<Record<Collapsible, boolean>>({ snoozed: false, settled: false, noise: false });
  const all = threads(rows).filter(thread => filter === "all" || thread.assistant === filter);
  const recipient = to ?? defaultAssistant(rows, false);

  const sections = (["active", "snoozed", "settled", "noise"] as const).map(shelf => {
    const items = all.filter(thread => thread.shelf === shelf);
    if (shelf === "settled") items.sort((first, second) => second.updatedAt.localeCompare(first.updatedAt));
    const collapsible = shelf !== "active";
    const shown = collapsible && !expanded[shelf] ? [] : shelf === "settled" ? items.slice(0, 30) : items;
    return { shelf, collapsible, count: items.length, data: shown };
  }).filter(section => section.count > 0);

  const ask = async (text: string) => {
    const ok = await run(() => createJob({ idempotencyKey: randomKey(), title: threadTitleFrom(text), instruction: text, assistant: recipient }),
      recipient === "fox" ? "Sent to Fox" : "Handed to Hermes");
    if (ok) setComposing(false);
    return ok;
  };

  if (ready && !connection) {
    return (
      <DockScene tab="inbox">
        <SectionList style={styles.list} contentContainerStyle={styles.content} sections={[]} onScroll={dock.onScroll} scrollEventThrottle={16} ListHeaderComponent={<ConnectPrompt />} />
      </DockScene>
    );
  }

  const roster = rows.capabilities.assistants;

  return (
    <DockScene tab="inbox">
      <SectionList
        style={styles.list}
        contentContainerStyle={styles.content}
        sections={sections}
        keyExtractor={thread => thread.key}
        stickySectionHeadersEnabled={false}
        keyboardShouldPersistTaps="handled"
        onScroll={dock.onScroll}
        scrollEventThrottle={16}
        refreshControl={<RefreshControl refreshing={loading} onRefresh={refresh} tintColor={colors.muted} colors={[colors.page]} progressBackgroundColor={colors.accent} />}
        ListHeaderComponent={<>
          {actionError ? <T tone="amber" accessibilityRole="alert" accessibilityLiveRegion="polite">{actionError}</T> : null}
          {error ? <T tone="amber" accessibilityRole="alert">{error}. Pull down to retry reading Inbox.</T> : null}
          {composing ? (
            <>
              {roster.filter(assistant => assistant.available).length > 1 ? (
                <View style={styles.chips}>
                  {roster.filter(assistant => assistant.available).map(assistant => (
                    <Chip key={assistant.id} label={`To ${assistant.name}`} on={recipient === assistant.id} onPress={() => setTo(assistant.id)} />
                  ))}
                </View>
              ) : null}
              <Composer label={`Message ${assistantName(recipient)}`} placeholder={`What should ${assistantName(recipient)} do?`} submitLabel="Send" onSubmit={ask} onCancel={() => setComposing(false)} />
            </>
          ) : <Button label="New thread" disabled={!assistantAvailable(rows, "fox") && !assistantAvailable(rows, "hermes")} onPress={() => setComposing(true)} />}
          {roster.length > 1 ? (
            <View style={[styles.chips, styles.filter]}>
              <Chip label="All" on={filter === "all"} onPress={() => setFilter("all")} />
              {roster.map(assistant => <Chip key={assistant.id} label={assistant.name} on={filter === assistant.id} onPress={() => setFilter(assistant.id)} />)}
            </View>
          ) : null}
        </>}
        renderSectionHeader={({ section }) => (
          <Section
            title={titles[section.shelf]}
            count={section.count}
            action={section.collapsible ? (
              <Pressable hitSlop={8} style={styles.toggle} onPress={() => setExpanded(current => ({ ...current, [section.shelf]: !current[section.shelf as Collapsible] }))}>
                <T size="tiny" tone="muted">{expanded[section.shelf as Collapsible] ? "Hide" : "Show"}</T>
              </Pressable>
            ) : undefined}
          />
        )}
        renderItem={({ item }) => <ThreadItem thread={item} />}
        ListEmptyComponent={<T size="small" tone="faint" style={styles.empty}>{!ready || loading && !loadedAt ? "Loading Inbox…" : error && !loadedAt ? "Inbox unavailable · pull down to retry" : "Inbox is clear"}</T>}
      />
    </DockScene>
  );
}

const styles = StyleSheet.create({
  list: { flex: 1, backgroundColor: colors.page },
  content: { padding: space.lg, paddingBottom: 120 },
  chips: { flexDirection: "row", flexWrap: "wrap", gap: space.sm, marginBottom: space.sm },
  filter: { marginTop: space.md, marginBottom: 0 },
  toggle: { minHeight: 48, minWidth: 48, justifyContent: "center", alignItems: "flex-end" },
  empty: { marginTop: space.xl },
});
