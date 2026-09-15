import {
  approveEmailSend, createGoogleTask, createJob, decideInboxItem, emailSendBlocksInboxMutation, saveOwnerDraft,
} from "@shared/inbox-client";
import type { InboxItemRow, InboxOutcome } from "@shared/row-model";
import { inboxStateLabel, relativeTime } from "@shared/work-threads";
import { router, useLocalSearchParams } from "expo-router";
import { useState } from "react";
import { StyleSheet, View } from "react-native";
import { ThreadItem } from "@/components/rows";
import { Actions, Button, Chip, Composer, Field, Missing, Panel, Screen, Section, T } from "@/components/ui";
import { defaultDestination, defaultPlan, oneLine, randomKey } from "@/lib/api";
import { tomorrowMorning } from "@/lib/dates";
import { currentDraft, jobsFor, jobThread, sendActionFor, sendState } from "@/lib/derive";
import { useStore } from "@/lib/store";
import { space } from "@/lib/theme";

type Decision = { state: InboxItemRow["state"]; outcome: InboxOutcome | null; snoozedUntil: string | null };

export default function InboxItemScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { rows, run } = useStore();
  const [editing, setEditing] = useState(false);
  const [body, setBody] = useState("");
  const [asking, setAsking] = useState(false);
  const [tasking, setTasking] = useState(false);
  const [taskTitle, setTaskTitle] = useState("");
  const [listId, setListId] = useState<string | null>(null);
  const item = rows.inbox.find(candidate => candidate.id === id);
  if (!item) return <Missing />;

  const draft = currentDraft(rows, item);
  const send = sendState(rows, item);
  const blocked = emailSendBlocksInboxMutation(sendActionFor(rows, item));
  const open = item.state === "open";
  const jobs = jobsFor(rows, { inboxId: item.id });
  const destination = rows.destinations.find(entry => entry.listId === listId) ?? defaultDestination(rows);

  const decide = async (decision: Decision, done: string) => {
    const ok = await run(() => decideInboxItem(item, decision), done);
    if (ok && decision.state !== "open") router.back();
  };

  const saveDraft = async () => {
    if (!draft) return;
    const ok = await run(() => saveOwnerDraft(item, { ...draft.reply, bodyText: body }), "Draft saved");
    if (ok) setEditing(false);
  };

  const makeTask = async () => {
    if (!destination) return;
    const ok = await run(() => createGoogleTask({
      destination: { accountId: destination.accountId, listId: destination.listId },
      nonce: randomKey(),
      title: oneLine(taskTitle, 1024),
      notes: "",
      doOn: null,
      plan: defaultPlan,
      inbox: { id: item.id, version: item.version },
    }), `Added to ${destination.listName}`);
    if (ok) router.back();
  };

  const handOver = async (text: string) => {
    const ok = await run(() => createJob({ idempotencyKey: randomKey(), title: oneLine(item.title, 200), instruction: text, inboxId: item.id }), "Handed to Hermes");
    if (ok) setAsking(false);
    return ok;
  };

  return (
    <Screen>
      <T size="title" bold>{item.title}</T>
      <T size="small" tone="faint">
        {[item.source.kind === "email" ? "Email" : item.source.kind === "hermes" ? "Hermes" : "Capture", relativeTime(item.createdAt),
          item.likelyNoise ? "likely noise" : null, inboxStateLabel(item, send)].filter(Boolean).join(" · ")}
      </T>
      <T style={styles.summary}>{item.summary}</T>

      {draft ? (
        <Panel>
          <T size="tiny" tone="faint" bold>{`DRAFT ${draft.revision} · ${draft.author === "hermes" ? "HERMES" : "YOU"}`}</T>
          <T size="small" tone="muted" style={styles.envelope}>{`To ${draft.reply.to.join(", ")}\n${draft.reply.subject}`}</T>
          {editing
            ? <Field value={body} onChangeText={setBody} multiline autoFocus />
            : <T size="small">{draft.reply.bodyText}</T>}
          {open && !blocked ? (
            <Actions>
              {editing ? (
                <>
                  <Button label="Save draft" tone="primary" disabled={!body.trim() || body === draft.reply.bodyText} onPress={() => { void saveDraft(); }} />
                  <Button label="Cancel" tone="quiet" onPress={() => setEditing(false)} />
                </>
              ) : (
                <>
                  {send === "ready" ? <Button label="Send" tone="primary" onPress={() => { void run(() => approveEmailSend(item, draft), "Sending"); }} /> : null}
                  <Button label="Edit" onPress={() => { setBody(draft.reply.bodyText); setEditing(true); }} />
                </>
              )}
            </Actions>
          ) : null}
        </Panel>
      ) : null}

      {tasking ? (
        <Panel>
          <Field value={taskTitle} onChangeText={setTaskTitle} placeholder="Task" autoFocus />
          <View style={styles.chips}>
            {rows.destinations.map(entry => (
              <Chip key={entry.listId} label={entry.listName} on={destination?.listId === entry.listId} onPress={() => setListId(entry.listId)} />
            ))}
          </View>
          <Actions>
            <Button label={destination ? `Add to ${destination.listName}` : "No task list"} tone="primary" disabled={!destination || !taskTitle.trim()} onPress={() => { void makeTask(); }} />
            <Button label="Cancel" tone="quiet" onPress={() => setTasking(false)} />
          </Actions>
        </Panel>
      ) : null}

      {blocked ? null : open ? (
        <Actions>
          {!tasking ? <Button label="Make task" onPress={() => { setTaskTitle(item.title); setTasking(true); }} /> : null}
          {!asking ? <Button label="Ask Hermes" onPress={() => setAsking(true)} /> : null}
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
