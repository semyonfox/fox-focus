import { answerJob, sendBackJob, settleJob } from "@shared/inbox-client";
import type { JobOutcome } from "@shared/row-model";
import { jobStateLabel, relativeTime } from "@shared/work-threads";
import { router, useLocalSearchParams } from "expo-router";
import { useState } from "react";
import { Linking, Pressable, StyleSheet, View } from "react-native";
import { Actions, Button, Dot, Field, Missing, Panel, Screen, Section, T } from "@/components/ui";
import { jobThread, taskTitle, threadTone, updateKindLabel, updatesFor } from "@/lib/derive";
import { useStore } from "@/lib/store";
import { colors, space } from "@/lib/theme";

export default function JobScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { rows, run } = useStore();
  const [answer, setAnswer] = useState("");
  const [note, setNote] = useState("");
  const [sendingBack, setSendingBack] = useState(false);
  const job = rows.jobs.find(candidate => candidate.id === id);
  if (!job) return <Missing />;

  const updates = updatesFor(rows, job.id);
  const task = job.taskId ? rows.tasks.find(candidate => candidate.id === job.taskId) ?? null : null;
  const item = job.inboxId ? rows.inbox.find(candidate => candidate.id === job.inboxId) ?? null : null;

  // accepting a job linked to a task ticks that task, so the server wants the task version the owner saw
  const settle = (outcome: JobOutcome) => {
    void run(() => settleJob(job, outcome, task?.version), outcome === "accepted" ? "Accepted" : "Dropped")
      .then(ok => { if (ok) router.back(); });
  };

  const submitAnswer = async () => {
    const text = answer.trim();
    if (text && await run(() => answerJob(job, text), "Answered")) setAnswer("");
  };

  const submitNote = async () => {
    const text = note.trim();
    if (text && await run(() => sendBackJob(job, text), "Sent back")) {
      setNote("");
      setSendingBack(false);
    }
  };

  return (
    <Screen>
      <View style={styles.state}>
        <Dot tone={threadTone(jobThread(job))} />
        <T size="small" tone="muted">{jobStateLabel(job)}</T>
      </View>
      <T size="title" bold>{job.title}</T>
      <T tone="muted" style={styles.instruction}>{job.instruction}</T>
      {task ? (
        <Pressable onPress={() => router.push({ pathname: "/task/[id]", params: { id: task.id } })} hitSlop={6}>
          <T size="small" tone="blue">{`Task · ${taskTitle(rows, task)}`}</T>
        </Pressable>
      ) : null}
      {item ? (
        <Pressable onPress={() => router.push({ pathname: "/inbox/[id]", params: { id: item.id } })} hitSlop={6}>
          <T size="small" tone="blue">{`Inbox · ${item.title}`}</T>
        </Pressable>
      ) : null}

      <Section title="Updates" count={updates.length} />
      {updates.length ? updates.map(update => {
        const url = update.url;
        return (
          <View key={update.seq} style={styles.update}>
            <T size="tiny" tone="faint">
              {`${update.author === "hermes" ? "Hermes" : "You"} · ${updateKindLabel[update.kind]} · ${relativeTime(update.at)}`}
            </T>
            <T tone={update.author === "owner" ? "muted" : "text"}>{update.text}</T>
            {url ? (
              <Pressable onPress={() => { void Linking.openURL(url); }} hitSlop={6}>
                <T size="small" tone="blue" numberOfLines={1}>{url.replace(/^https?:\/\//, "")}</T>
              </Pressable>
            ) : null}
          </View>
        );
      }) : <T size="small" tone="faint">No updates yet</T>}

      {job.state === "needs_you" ? (
        <Panel>
          <Field
            value={answer}
            onChangeText={text => setAnswer(text.replace(/[\r\n]/g, " "))}
            placeholder="Answer Hermes"
            maxLength={280}
            returnKeyType="send"
            onSubmitEditing={() => { void submitAnswer(); }}
          />
          <Actions>
            <Button label="Answer" tone="primary" disabled={!answer.trim()} onPress={() => { void submitAnswer(); }} />
          </Actions>
        </Panel>
      ) : null}

      {job.state === "review" ? (
        sendingBack ? (
          <Panel>
            <Field
              value={note}
              onChangeText={text => setNote(text.replace(/[\r\n]/g, " "))}
              placeholder="What should change"
              maxLength={280}
              autoFocus
              returnKeyType="send"
              onSubmitEditing={() => { void submitNote(); }}
            />
            <Actions>
              <Button label="Send back" tone="primary" disabled={!note.trim()} onPress={() => { void submitNote(); }} />
              <Button label="Cancel" tone="quiet" onPress={() => setSendingBack(false)} />
            </Actions>
          </Panel>
        ) : (
          <Actions>
            <Button label={task ? "Accept and tick task" : "Accept"} tone="primary" onPress={() => settle("accepted")} />
            <Button label="Send back" onPress={() => setSendingBack(true)} />
            <Button label="Drop" tone="quiet" onPress={() => settle("dropped")} />
          </Actions>
        )
      ) : null}
    </Screen>
  );
}

const styles = StyleSheet.create({
  state: { flexDirection: "row", alignItems: "center", gap: space.sm, marginBottom: space.xs },
  instruction: { marginTop: space.xs, marginBottom: space.sm },
  update: {
    paddingVertical: space.sm,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.lineSoft,
  },
});
