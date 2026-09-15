import type { TaskRow } from "@shared/row-model";
import { useState } from "react";
import { RefreshControl, SectionList, StyleSheet, View } from "react-native";
import { TaskItem } from "@/components/rows";
import { ConnectPrompt } from "@/components/status-line";
import { Chip, Field, Section, T } from "@/components/ui";
import { doneTasks, groupByWhen, listName, openTasks, taskTitle } from "@/lib/derive";
import { useStore } from "@/lib/store";
import { colors, space } from "@/lib/theme";

export default function Tasks() {
  const { rows, loading, refresh, connection, ready } = useStore();
  const [view, setView] = useState<"open" | "done">("open");
  const [query, setQuery] = useState("");
  const needle = query.trim().toLowerCase();
  const matches = (task: TaskRow) => !needle ||
    taskTitle(rows, task).toLowerCase().includes(needle) || listName(rows, task).toLowerCase().includes(needle);
  const sections = view === "open"
    ? groupByWhen(rows, openTasks(rows).filter(matches))
    : [{ title: "Done", data: doneTasks(rows).filter(matches).slice(0, 100) }].filter(section => section.data.length);

  return (
    <SectionList
      style={styles.list}
      contentContainerStyle={styles.content}
      sections={sections}
      keyExtractor={task => task.id}
      stickySectionHeadersEnabled={false}
      keyboardShouldPersistTaps="handled"
      refreshControl={<RefreshControl refreshing={loading} onRefresh={refresh} tintColor={colors.muted} colors={[colors.page]} progressBackgroundColor={colors.accent} />}
      ListHeaderComponent={
        <View>
          <View style={styles.chips}>
            <Chip label="Open" on={view === "open"} onPress={() => setView("open")} />
            <Chip label="Done" on={view === "done"} onPress={() => setView("done")} />
          </View>
          <Field value={query} onChangeText={setQuery} placeholder="Search" autoCorrect={false} returnKeyType="search" />
        </View>
      }
      renderSectionHeader={({ section }) => <Section title={section.title} count={section.data.length} />}
      renderItem={({ item }) => <TaskItem task={item} />}
      ListEmptyComponent={ready && !connection
        ? <ConnectPrompt />
        : <T size="small" tone="faint" style={styles.empty}>{needle ? "No matches" : "Nothing here"}</T>}
    />
  );
}

const styles = StyleSheet.create({
  list: { flex: 1, backgroundColor: colors.page },
  content: { padding: space.lg, paddingBottom: 120 },
  chips: { flexDirection: "row", gap: space.sm, marginBottom: space.md },
  empty: { marginTop: space.xl },
});
