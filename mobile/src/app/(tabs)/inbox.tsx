import { createJob } from "@shared/inbox-client";
import type { WorkThreadGroup } from "@shared/work-threads";
import { useState } from "react";
import { Pressable, RefreshControl, SectionList, StyleSheet } from "react-native";
import { ThreadItem } from "@/components/rows";
import { ConnectPrompt } from "@/components/status-line";
import { Button, Composer, Section, T } from "@/components/ui";
import { oneLine, randomKey } from "@/lib/api";
import { threads } from "@/lib/derive";
import { useStore } from "@/lib/store";
import { colors, space } from "@/lib/theme";

const titles: Record<WorkThreadGroup, string> = { needs_you: "Needs you", working: "Working", noise: "Likely noise", settled: "Settled" };

type Collapsible = "noise" | "settled";

export default function Inbox() {
  const { rows, run, loading, refresh, connection, ready } = useStore();
  const [composing, setComposing] = useState(false);
  const [expanded, setExpanded] = useState<Record<Collapsible, boolean>>({ noise: false, settled: false });
  const all = threads(rows);

  const sections = (["needs_you", "working", "noise", "settled"] as const).map(group => {
    const items = all.filter(thread => thread.group === group);
    const collapsible = group === "noise" || group === "settled";
    const shown = collapsible && !expanded[group] ? [] : group === "settled" ? items.slice(0, 30) : items;
    return { group, collapsible, count: items.length, data: shown };
  }).filter(section => section.count > 0);

  const ask = async (text: string) => {
    const ok = await run(() => createJob({ idempotencyKey: randomKey(), title: oneLine(text, 200), instruction: text }), "Handed to Hermes");
    if (ok) setComposing(false);
    return ok;
  };

  if (ready && !connection) {
    return <SectionList style={styles.list} contentContainerStyle={styles.content} sections={[]} ListHeaderComponent={<ConnectPrompt />} />;
  }

  return (
    <SectionList
      style={styles.list}
      contentContainerStyle={styles.content}
      sections={sections}
      keyExtractor={thread => thread.key}
      stickySectionHeadersEnabled={false}
      keyboardShouldPersistTaps="handled"
      refreshControl={<RefreshControl refreshing={loading} onRefresh={refresh} tintColor={colors.muted} colors={[colors.page]} progressBackgroundColor={colors.accent} />}
      ListHeaderComponent={composing
        ? <Composer placeholder="What should Hermes do?" submitLabel="Hand over" onSubmit={ask} onCancel={() => setComposing(false)} />
        : <Button label="Ask Hermes" onPress={() => setComposing(true)} />}
      renderSectionHeader={({ section }) => (
        <Section
          title={titles[section.group]}
          count={section.count}
          action={section.collapsible ? (
            <Pressable hitSlop={8} onPress={() => setExpanded(current => ({ ...current, [section.group]: !current[section.group as Collapsible] }))}>
              <T size="tiny" tone="muted">{expanded[section.group as Collapsible] ? "Hide" : "Show"}</T>
            </Pressable>
          ) : undefined}
        />
      )}
      renderItem={({ item }) => <ThreadItem thread={item} />}
      ListEmptyComponent={<T size="small" tone="faint" style={styles.empty}>Inbox zero</T>}
    />
  );
}

const styles = StyleSheet.create({
  list: { flex: 1, backgroundColor: colors.page },
  content: { padding: space.lg, paddingBottom: 120 },
  empty: { marginTop: space.xl },
});
