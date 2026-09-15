import { briefingReminderSuggestion, createGoogleTask } from "@shared/inbox-client";
import type { BriefingEntry } from "@shared/row-model";
import { useState } from "react";
import { Linking, Pressable, StyleSheet, View } from "react-native";
import { defaultDestination, defaultPlan, oneLine, randomKey } from "@/lib/api";
import { dublinDateKey, whenLabel } from "@/lib/dates";
import { useStore } from "@/lib/store";
import { colors, space } from "@/lib/theme";
import { Actions, Button, Panel, Section, T } from "./ui";

// today's Hermes brief: news and upcoming events, collapsed until opened
export function BriefingCard() {
  const { rows, run, notify } = useStore();
  const [open, setOpen] = useState(false);
  const today = dublinDateKey();
  const briefing = rows.briefings.find(entry => entry.day === today && Date.parse(entry.expiresAt) > Date.now());
  if (!briefing?.entries.length) return null;

  const save = (entry: BriefingEntry, remind: boolean) => {
    const destination = defaultDestination(rows);
    if (!destination) {
      notify("No Google task list is available");
      return;
    }
    const reminder = remind ? briefingReminderSuggestion(entry, new Date()) : null;
    if (remind && !reminder) {
      notify("It starts too soon for a reminder");
      return;
    }
    void run(() => createGoogleTask({
      destination: { accountId: destination.accountId, listId: destination.listId },
      nonce: randomKey(),
      title: oneLine(entry.title, 1024),
      notes: entry.url ?? "",
      doOn: entry.startsAt ? dublinDateKey(new Date(entry.startsAt)) : null,
      plan: defaultPlan,
      ...(reminder ? { reminder: { fireAt: reminder.fireAt } } : {}),
    }), remind ? `Reminder set in ${destination.listName}` : `Saved to ${destination.listName}`);
  };

  return (
    <>
      <Section
        title="Morning brief"
        count={briefing.entries.length}
        action={
          <Pressable hitSlop={8} onPress={() => setOpen(current => !current)}>
            <T size="tiny" tone="muted">{open ? "Hide" : "Show"}</T>
          </Pressable>
        }
      />
      {open ? briefing.entries.map((entry, index) => {
        const url = entry.url;
        return (
          <Panel key={`${briefing.day}-${index}`}>
            <T size="tiny" tone="faint" bold>
              {[entry.kind === "event" ? "EVENT" : "NEWS", entry.startsAt ? whenLabel(entry.startsAt) : null].filter(Boolean).join(" · ")}
            </T>
            {url ? (
              <Pressable onPress={() => { void Linking.openURL(url); }} hitSlop={4}>
                <T bold tone="blue">{entry.title}</T>
              </Pressable>
            ) : <T bold>{entry.title}</T>}
            {entry.summary ? <T size="small" tone="muted">{entry.summary}</T> : null}
            <Actions>
              <Button label="Save as task" onPress={() => save(entry, false)} />
              <Button label="Remind me" tone="quiet" onPress={() => save(entry, true)} />
            </Actions>
          </Panel>
        );
      }) : <View style={styles.spacer} />}
    </>
  );
}

const styles = StyleSheet.create({
  spacer: { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.lineSoft, marginBottom: space.xs },
});
