import {
  approveEmailSend, createJob, decideInboxItem, emailSendBlocksInboxMutation, saveOwnerDraft,
} from "@shared/inbox-client";
import { sourceCreationNonce } from "@shared/task-creation-guard";
import type { DraftRevision, InboxItemRow, InboxOutcome, TaskCreateInput } from "@shared/row-model";
import { inboxStateLabel, relativeTime } from "@shared/work-threads";
import { router, useLocalSearchParams } from "expo-router";
import { useState } from "react";
import { StyleSheet, View } from "react-native";
import { TaskCreationPreview } from "@/components/task-creation-preview";
import { ThreadItem } from "@/components/rows";
import { Actions, Button, Chip, Composer, Fact, Field, Missing, Panel, Screen, Section, T } from "@/components/ui";
import { defaultDestination, defaultPlan, oneLine, randomKey } from "@/lib/api";
import { tomorrowMorning } from "@/lib/dates";
import { activeJobFor, assistantAvailable, currentDraft, jobsFor, jobThread, sendActionFor, sendState } from "@/lib/derive";
import { useStore } from "@/lib/store";
import { space } from "@/lib/theme";

type Decision = { state: InboxItemRow["state"]; outcome: InboxOutcome | null; snoozedUntil: string | null };
type DraftEdit = {
  item: Pick<InboxItemRow, "id" | "version">;
  draft: DraftRevision;
  body: string;
  saving: boolean;
};

export default function InboxItemScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { rows, run } = useStore();
  const [draftEdit, setDraftEdit] = useState<DraftEdit | null>(null);
  const [asking, setAsking] = useState(false);
  const [tasking, setTasking] = useState(false);
  const [taskTitle, setTaskTitle] = useState("");
  const [destinationKey, setDestinationKey] = useState<string | null>(null);
  const [creation, setCreation] = useState<{ input: TaskCreateInput; listName: string } | null>(null);
  const item = rows.inbox.find(candidate => candidate.id === id);
  if (!item) return <Missing />;

  const draft = currentDraft(rows, item);
  const send = sendState(rows, item);
  const blocked = emailSendBlocksInboxMutation(sendActionFor(rows, item));
  const open = item.state === "open";
  const edit = draftEdit?.item.id === item.id ? draftEdit : null;
  const stale = edit !== null && (edit.item.version !== item.version || edit.draft.id !== draft?.id || !open || blocked);
  const previewDraft = edit?.draft ?? draft;
  const saveDisabled = !edit || stale || edit.saving || !edit.body.trim() || edit.body === edit.draft.reply.bodyText;
  const jobs = jobsFor(rows, { inboxId: item.id });
  const destination = rows.destinations.find(entry => `${entry.accountId}:${entry.listId}` === destinationKey) ?? defaultDestination(rows);

  const decide = async (decision: Decision, done: string) => {
    const ok = await run(() => decideInboxItem(item, decision), done);
    if (ok && decision.state !== "open") router.back();
  };

  const saveDraft = async () => {
    if (!edit || saveDisabled) return;
    setDraftEdit({ ...edit, saving: true });
    const ok = await run(() => saveOwnerDraft(edit.item, { ...edit.draft.reply, bodyText: edit.body }), "Draft saved");
    setDraftEdit(current => {
      if (current?.item !== edit.item) return current;
      return ok ? null : { ...current, saving: false };
    });
  };

  const makeTask = () => {
    if (!destination) return;
    setCreation({ listName: destination.listName, input: {
      destination: { accountId: destination.accountId, listId: destination.listId },
      nonce: sourceCreationNonce("inbox", item.id),
      title: oneLine(taskTitle, 1024),
      notes: "",
      doOn: null,
      plan: defaultPlan,
      inbox: { id: item.id, version: item.version },
    } });
  };

  const handOver = async (text: string) => {
    const ok = await run(() => createJob({ idempotencyKey: randomKey(), title: oneLine(item.title, 200), instruction: text, inboxId: item.id }), "Handed to Hermes");
    if (ok) setAsking(false);
    return ok;
  };

  return (
    <Screen>
      {creation ? <TaskCreationPreview {...creation} onClose={() => setCreation(null)} onCreated={() => { setCreation(null); router.back(); }} /> : null}
      <T size="title" bold>{item.title}</T>
      <T size="small" tone="faint">
        {[item.source.kind === "email" ? "Email" : item.source.kind === "hermes" ? "Hermes" : "Capture", relativeTime(item.createdAt),
          item.likelyNoise ? "likely noise" : null, inboxStateLabel(item, send)].filter(Boolean).join(" · ")}
      </T>
      <T style={styles.summary}>{item.summary}</T>

      {previewDraft ? (
        <Panel>
          <T size="tiny" tone="faint" bold>{`DRAFT ${previewDraft.revision} · ${previewDraft.author === "hermes" ? "HERMES" : "YOU"}`}</T>
          <Fact label="Account" value={previewDraft.reply.accountId} />
          <Fact label="From" value={previewDraft.reply.from} />
          <Fact label="To" value={previewDraft.reply.to.join(", ")} />
          <Fact label="Cc" value={previewDraft.reply.cc.join(", ") || "None"} />
          <Fact label="Bcc" value={previewDraft.reply.bcc.join(", ") || "None"} />
          <Fact label="Subject" value={previewDraft.reply.subject} />
          <Fact label="Thread" value={previewDraft.reply.threadId} />
          <Fact label="Reply to" value={previewDraft.reply.replyToMessageId} />
          <Fact label="In reply to" value={previewDraft.reply.inReplyTo} />
          <Fact label="References" value={previewDraft.reply.references.join(", ") || "None"} />
          {edit ? (
            <>
              {stale && !edit.saving ? (
                <T size="small" tone="amber" accessibilityRole="alert" accessibilityLiveRegion="polite">
                  The Inbox item changed. Copy your changes before discarding this edit.
                </T>
              ) : null}
              <Field
                label="Reply body"
                value={edit.body}
                editable={!edit.saving}
                onChangeText={body => setDraftEdit(current => current?.item === edit.item && !current.saving ? { ...current, body } : current)}
                multiline
                autoFocus
              />
              <Actions>
                <Button label="Save draft" tone="primary" disabled={saveDisabled} onPress={() => { void saveDraft(); }} />
                <Button label={stale ? "Discard edit" : "Cancel"} tone="quiet" disabled={edit.saving} onPress={() => setDraftEdit(null)} />
              </Actions>
            </>
          ) : <T size="small">{previewDraft.reply.bodyText}</T>}
          {!edit && draft && open && !blocked ? (
            <Actions>
              {send === "ready" ? <Button label="Send" tone="primary" onPress={() => { void run(() => approveEmailSend(item, draft), "Sending"); }} /> : null}
              <Button label="Edit" onPress={() => setDraftEdit({
                item: { id: item.id, version: item.version },
                draft,
                body: draft.reply.bodyText,
                saving: false,
              })} />
            </Actions>
          ) : null}
        </Panel>
      ) : null}

      {tasking ? (
        <Panel>
          <Field label="Task title" value={taskTitle} onChangeText={setTaskTitle} placeholder="Task" autoFocus />
          <View style={styles.chips}>
            {rows.destinations.map(entry => (
              <Chip key={`${entry.accountId}:${entry.listId}`} label={`${entry.listName} · ${entry.accountId}`} on={destination?.listId === entry.listId && destination.accountId === entry.accountId} onPress={() => setDestinationKey(`${entry.accountId}:${entry.listId}`)} />
            ))}
          </View>
          <Actions>
            <Button label={destination ? "Review outgoing task" : "No task list"} tone="primary" disabled={!destination || !taskTitle.trim()} onPress={() => { void makeTask(); }} />
            <Button label="Cancel" tone="quiet" onPress={() => setTasking(false)} />
          </Actions>
        </Panel>
      ) : null}

      {blocked ? null : open ? (
        <Actions>
          {!tasking ? <Button label="Make task" onPress={() => { setTaskTitle(item.title); setTasking(true); }} /> : null}
          {activeJobFor(rows, { inboxId: item.id })
            ? null
            : !asking ? <Button label="Ask Hermes" disabled={!assistantAvailable(rows, "hermes")} onPress={() => setAsking(true)} /> : null}
          <Button label="Snooze" onPress={() => { void decide({ state: "waiting", outcome: null, snoozedUntil: tomorrowMorning() }, "Snoozed until 09:00"); }} />
          <Button label="Done" onPress={() => { void decide({ state: "resolved", outcome: "read", snoozedUntil: null }, "Done"); }} />
          <Button label="Not interested" tone="quiet" onPress={() => { void decide({ state: "resolved", outcome: "dismissed", snoozedUntil: null }, "Marked not interested"); }} />
          <Button label="Noise" tone="quiet" onPress={() => { void decide({ state: "resolved", outcome: "noise", snoozedUntil: null }, "Marked as noise"); }} />
        </Actions>
      ) : (
        <Actions>
          <Button label="Reopen" tone="quiet" onPress={() => { void decide({ state: "open", outcome: null, snoozedUntil: null }, "Reopened"); }} />
        </Actions>
      )}
      {asking ? <Composer placeholder="What should Hermes do with this?" submitLabel="Hand over" onSubmit={handOver} onCancel={() => setAsking(false)} /> : null}

      {jobs.length ? (
        <>
          <Section title="Hermes" count={jobs.length} />
          {jobs.map(job => <ThreadItem key={job.id} thread={jobThread(job)} />)}
        </>
      ) : null}
    </Screen>
  );
}

const styles = StyleSheet.create({
  summary: { marginTop: space.md },
  envelope: { marginVertical: space.sm },
  chips: { flexDirection: "row", flexWrap: "wrap", gap: space.sm, marginBottom: space.xs },
});
