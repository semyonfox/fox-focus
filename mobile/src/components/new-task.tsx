import type { TaskCreateInput } from "@shared/row-model";
import { useState } from "react";
import { StyleSheet, View } from "react-native";
import { defaultDestination, defaultPlan, oneLine, randomKey } from "@/lib/api";
import { useStore } from "@/lib/store";
import { space } from "@/lib/theme";
import { DayField } from "./plan-editor";
import { TaskCreationPreview } from "./task-creation-preview";
import { Actions, Button, Chip, Field, Panel, T } from "./ui";

// a new Google task: the exact outgoing fields are shown in the preview before anything is sent
export function NewTask({ onClose }: { onClose: () => void }) {
  const { rows } = useStore();
  const [title, setTitle] = useState("");
  const [notes, setNotes] = useState("");
  const [doOn, setDoOn] = useState<string | null>(null);
  const [destinationKey, setDestinationKey] = useState<string | null>(null);
  // one nonce per draft, so reviewing twice can never create twice
  const [nonce] = useState(() => `manual-${randomKey()}`);
  const [creation, setCreation] = useState<{ input: TaskCreateInput; listName: string } | null>(null);
  const destination = rows.destinations.find(entry => `${entry.accountId}:${entry.listId}` === destinationKey) ?? defaultDestination(rows);

  const review = () => {
    if (!destination || !title.trim()) return;
    setCreation({ listName: destination.listName, input: {
      destination: { accountId: destination.accountId, listId: destination.listId },
      nonce,
      title: oneLine(title, 1024),
      notes: notes.trim(),
      doOn,
      plan: defaultPlan,
    } });
  };

  return (
    <Panel>
      {creation ? <TaskCreationPreview {...creation} onClose={() => setCreation(null)} onCreated={() => { setCreation(null); onClose(); }} /> : null}
      <Field label="Title" value={title} onChangeText={setTitle} placeholder="What needs doing" autoFocus maxLength={1024} returnKeyType="next" />
      <Field label="Notes" value={notes} onChangeText={setNotes} placeholder="Optional" multiline maxLength={4000} />
      {rows.destinations.length ? (
        <View style={styles.chips}>
          {rows.destinations.map(entry => {
            const key = `${entry.accountId}:${entry.listId}`;
            return <Chip key={key} label={entry.listName} on={destination?.listId === entry.listId && destination.accountId === entry.accountId} onPress={() => setDestinationKey(key)} />;
          })}
        </View>
      ) : <T size="small" tone="amber">No Google task list is available</T>}
      <DayField label="Due" value={doOn} onChange={setDoOn} />
      <Actions>
        <Button label="Review" tone="primary" disabled={!destination || !title.trim()} onPress={review} />
        <Button label="Cancel" tone="quiet" onPress={onClose} />
      </Actions>
    </Panel>
  );
}

const styles = StyleSheet.create({
  chips: { flexDirection: "row", flexWrap: "wrap", gap: space.sm, marginBottom: space.sm },
});
