import { createGoogleTask } from "@shared/inbox-client";
import { taskCreateNotes, type TaskCreateInput } from "@shared/row-model";
import { hasCreationAttempt, heldCreationInput, holdCreationAttempt } from "@shared/task-creation-guard";
import { useRef, useState } from "react";
import { Modal, ScrollView, StyleSheet, View } from "react-native";
import { whenLabel } from "@/lib/dates";
import { useStore } from "@/lib/store";
import { colors, space } from "@/lib/theme";
import { Actions, Button, Fact, T } from "./ui";

export function TaskCreationPreview({ input: providedInput, listName, onClose, onCreated }: {
  input: TaskCreateInput;
  listName: string;
  onClose: () => void;
  onCreated: () => void;
}) {
  const { run, rows, refresh } = useStore();
  const input = heldCreationInput(providedInput.nonce) ?? providedInput;
  const alreadySubmitted = () => hasCreationAttempt(input.nonce) || rows.actions.some(action => action.payload.kind === "task-create" && action.payload.nonce === input.nonce);
  const started = useRef(false);
  const [busy, setBusy] = useState(false);
  const [unconfirmed, setUnconfirmed] = useState(alreadySubmitted);
  const close = () => { if (!busy) onClose(); };
  const approve = async () => {
    if (started.current || alreadySubmitted() || !holdCreationAttempt(input)) { setUnconfirmed(true); return; }
    started.current = true;
    setBusy(true);
    const ok = await run(() => createGoogleTask(input), "Creation queued · waiting for Google confirmation");
    setBusy(false);
    if (ok) onCreated();
    else setUnconfirmed(true);
  };
  return (
    <Modal visible animationType="none" onRequestClose={close}>
      <View style={styles.page} accessibilityViewIsModal>
        <ScrollView contentContainerStyle={styles.content}>
          <T size="title" bold accessibilityRole="header">Create in Google</T>
          <T>Review the exact outgoing task. Planning and reminders stay in Fox Focus.</T>
          <Fact label="Account" value={input.destination.accountId} />
          <Fact label="List" value={listName} />
          <Fact label="List ID" value={input.destination.listId} />
          <Fact label="Title" value={input.title} />
          <Fact label="Google due" value={input.doOn ?? "None"} />
          <Fact label="Reminder" value={input.reminder ? `${whenLabel(input.reminder.fireAt)} · ${input.reminder.fireAt}` : "None"} />
          <T bold>Notes sent to Google</T>
          <T>{taskCreateNotes(input.notes, input.nonce)}</T>
          <T size="small" tone="muted">The Fox-Focus-ID marker prevents duplicate creation.</T>
          {unconfirmed ? <T tone="amber" accessibilityRole="alert" accessibilityLiveRegion="polite">This creation was already submitted. Check Tasks for its result. An unknown outcome needs reconciliation; a new creation is blocked.</T> : null}
          <Actions>
            <Button label={busy ? "Recording approval…" : "Create in Google"} tone="primary" disabled={busy || unconfirmed} onPress={() => { void approve(); }} />
            <Button label={unconfirmed ? "Close and check Tasks" : "Cancel"} disabled={busy} onPress={close} />
            {unconfirmed ? <Button label="Refresh task state" onPress={() => { void refresh(); }} /> : null}
          </Actions>
        </ScrollView>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: colors.page },
  content: { padding: space.lg, paddingTop: space.xl, paddingBottom: 60, gap: space.md },
});
