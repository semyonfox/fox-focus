import { answerJob, loadJobThread, sendBackJob, settleJob, snoozeJob } from "@shared/inbox-client";
import type { Job, JobOutcome, ThreadEntry } from "@shared/row-model";
import { assistantName, hermesThreadEntries, jobStateLabel, relativeTime, snoozePresets } from "@shared/work-threads";
import { router, Stack, useLocalSearchParams } from "expo-router";
import { useEffect, useState } from "react";
import { Linking, Pressable, StyleSheet, View } from "react-native";
import { Actions, Button, Chip, Dot, Field, Missing, Panel, Screen, T } from "@/components/ui";
import { jobThread, taskTitle, threadTone, updatesFor } from "@/lib/derive";
import { useStore } from "@/lib/store";
import { colors, radius, space } from "@/lib/theme";

// Fox keeps its transcript server-side; reload it whenever the job moves on
function useFoxEntries(job: Job | undefined): ThreadEntry[] | null {
  const [loaded, setLoaded] = useState<{ stamp: string; entries: ThreadEntry[] } | null>(null);
  const stamp = job && job.assistant === "fox" ? `${job.id}:${job.version}:${job.updatedAt}` : null;
  useEffect(() => {
    if (!stamp || !job) return;
    let cancelled = false;
    loadJobThread(job.id).then(entries => { if (!cancelled) setLoaded({ stamp, entries }); }, () => { /* the next poll retries */ });
    return () => { cancelled = true; };
  }, [stamp]);
  return loaded && stamp && loaded.stamp.startsWith(`${job?.id}:`) ? loaded.entries : null;
}

export default function JobScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { rows, run } = useStore();
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [snoozing, setSnoozing] = useState(false);
  const job = rows.jobs.find(candidate => candidate.id === id);
  const foxEntries = useFoxEntries(job);
  if (!job) return <Missing />;

  const hermes = job.assistant === "hermes";
  const name = assistantName(job.assistant);
  const entries = hermes ? hermesThreadEntries(job, updatesFor(rows, job.id)) : foxEntries;
  const waiting = job.state === "needs_you";
  const working = job.state === "queued" || job.state === "working";
  const lastQuestionSeq = waiting ? entries?.filter(entry => entry.kind === "question").at(-1)?.seq ?? null : null;
  const limit = hermes ? 280 : 4_000;
  const task = job.taskId ? rows.tasks.find(candidate => candidate.id === job.taskId) ?? null : null;
  const item = job.inboxId ? rows.inbox.find(candidate => candidate.id === job.inboxId) ?? null : null;

  const act = async (change: () => Promise<unknown>, done: string) => {
    setBusy(true);
    const ok = await run(change, done);
    setBusy(false);
    return ok;
  };

  // settling is done and dealt with; it never ticks the linked task
  const settle = (outcome: JobOutcome) => {
    void act(() => settleJob(job, outcome), outcome === "accepted" ? "Settled" : "Dropped").then(ok => { if (ok) router.back(); });
  };

  const answer = async (text: string) => {
    if (await act(() => answerJob(job, text), `Answer sent to ${name}`)) setDraft("");
  };

  const submit = async () => {
    const text = draft.trim();
    if (!text || busy) return;
    if (waiting) await answer(text);
    else if (await act(() => sendBackJob(job, text), hermes ? "Sent back to Hermes" : "Sent to Fox")) setDraft("");
  };

  const snooze = (until: string | null) => {
    setSnoozing(false);
    void act(() => snoozeJob(job, until), until ? "Snoozed" : "Woken");
  };

  const placeholder = working ? `${name} is working…`
    : waiting ? hermes ? "Answer in one line" : "Or answer in your own words"
    : hermes ? "Reply in one line to send it back"
    : job.state === "settled" ? "Reply to reopen" : "Reply, or say we're done";

  return (
    <>
      <Stack.Screen options={{ title: name }} />
      <Screen>
        <View style={styles.state}>
          <Dot tone={threadTone(jobThread(job))} />
          <T size="small" tone="muted">{`${jobStateLabel(job)} · ${relativeTime(job.updatedAt)}`}</T>
          {job.snoozedUntil && Date.parse(job.snoozedUntil) > Date.now() ? <T size="small" tone="faint">· snoozed</T> : null}
        </View>
        <T size="title" bold>{job.title}</T>
        {task ? (
          <Pressable onPress={() => router.push({ pathname: "/task/[id]", params: { id: task.id } })} hitSlop={6} style={styles.link}>
            <T size="small" tone="blue">{`Task · ${taskTitle(rows, task)}`}</T>
          </Pressable>
        ) : null}
        {item ? (
          <Pressable onPress={() => router.push({ pathname: "/inbox/[id]", params: { id: item.id } })} hitSlop={6} style={styles.link}>
            <T size="small" tone="blue">{`Inbox · ${item.title}`}</T>
          </Pressable>
        ) : null}

        <Actions>
          {job.state === "review" ? <Button label="Settle" tone="primary" disabled={busy} onPress={() => settle("accepted")} /> : null}
          {job.state === "review" ? <Button label="Drop" tone="quiet" disabled={busy} onPress={() => settle("dropped")} /> : null}
          {job.state !== "settled" ? <Button label="Snooze" tone="quiet" disabled={busy} onPress={() => setSnoozing(current => !current)} /> : null}
        </Actions>
        {snoozing ? (
          <View style={styles.chips}>
            {snoozePresets(new Date()).map(preset => <Chip key={preset.id} label={preset.label} on={false} onPress={() => snooze(preset.until)} />)}
            {job.snoozedUntil ? <Chip label="Wake now" on={false} onPress={() => snooze(null)} /> : null}
          </View>
        ) : null}

        <View style={styles.thread}>
          {entries === null ? <T size="small" tone="faint">Loading the thread…</T> : null}
          {entries?.map((entry, index) => {
            const key = `${entry.seq}:${index}`;
            if (entry.kind === "activity") return <T key={key} size="small" tone="faint" style={styles.activity}>{entry.text}</T>;
            if (entry.kind === "question") {
              const live = entry.seq === lastQuestionSeq;
              return (
                <Panel key={key} style={live ? styles.liveAsk : undefined}>
                  <T size="tiny" tone={live ? "amber" : "faint"} bold>{`${name.toUpperCase()} IS ASKING`}</T>
                  <T>{entry.text}</T>
                  {entry.options.length ? (
                    <View style={styles.chips}>
                      {entry.options.map(option => <Chip key={option} label={option} on={false} onPress={() => { if (live && !busy) void answer(option); }} />)}
                    </View>
                  ) : null}
                </Panel>
              );
            }
            const url = entry.url;
            return (
              <View key={key} style={[styles.bubble, entry.role === "owner" ? styles.owner : styles.assistant]}>
                <T size="tiny" tone="faint">{`${entry.role === "owner" ? "You" : name} · ${relativeTime(entry.at)}`}</T>
                <T tone={entry.role === "owner" ? "muted" : "text"}>{entry.text}</T>
                {url ? (
                  <Pressable onPress={() => { void Linking.openURL(url); }} hitSlop={6}>
                    <T size="small" tone="blue" numberOfLines={1}>Open result</T>
                  </Pressable>
                ) : null}
              </View>
            );
          })}
          {working ? <T size="small" tone="blue" style={styles.activity}>{job.state === "queued" ? "Queued" : `${name} is working`}</T> : null}
          {job.state === "review" && job.resultKind === "failed" ? <T size="small" tone="amber">{job.resultNote ?? "This run failed."}</T> : null}
        </View>

        <Panel>
          <Field
            label={waiting ? "Answer" : "Reply"}
            value={draft}
            onChangeText={text => setDraft(hermes ? text.replace(/[\r\n]/g, " ") : text)}
            placeholder={placeholder}
            maxLength={limit}
            multiline={!hermes}
            editable={!working && !busy}
            returnKeyType={hermes ? "send" : "default"}
            onSubmitEditing={hermes ? () => { void submit(); } : undefined}
          />
          <Actions>
            <Button label="Send" tone="primary" disabled={!draft.trim() || working || busy} onPress={() => { void submit(); }} />
          </Actions>
        </Panel>
      </Screen>
    </>
  );
}

const styles = StyleSheet.create({
  state: { flexDirection: "row", alignItems: "center", gap: space.sm, marginBottom: space.xs },
  link: { minHeight: 32, justifyContent: "center" },
  chips: { flexDirection: "row", flexWrap: "wrap", gap: space.sm, marginTop: space.sm },
  thread: { marginTop: space.lg, gap: space.sm },
  activity: { paddingHorizontal: space.xs },
  liveAsk: { borderColor: colors.amber },
  bubble: { borderRadius: radius, padding: space.md, borderWidth: 1, maxWidth: "92%" },
  owner: { alignSelf: "flex-end", backgroundColor: colors.panelMuted, borderColor: colors.line },
  assistant: { alignSelf: "flex-start", backgroundColor: colors.panel, borderColor: colors.line },
});
