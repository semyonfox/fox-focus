import { createJob } from "@shared/inbox-client";
import { requestTaskPlan } from "@shared/row-client";
import type { Priority } from "@shared/model";
import type { TaskPlanRow } from "@shared/row-model";
import { useLocalSearchParams } from "expo-router";
import { useState } from "react";
import { Linking, StyleSheet, View } from "react-native";
import { tickTask, ThreadItem } from "@/components/rows";
import { Actions, Button, Chip, Composer, Fact, Missing, Panel, Screen, Section, T } from "@/components/ui";
import { expectOk, oneLine, randomKey } from "@/lib/api";
import { dayLabel, whenLabel } from "@/lib/dates";
import { canTick, isDone, isPending, isStuck, jobsFor, jobThread, latestTaskAction, listName, planFor, taskTitle } from "@/lib/derive";
import { useStore } from "@/lib/store";
import { space } from "@/lib/theme";

const priorities: { value: Priority; label: string }[] = [
  { value: "high", label: "High" }, { value: "medium", label: "Medium" }, { value: "low", label: "Low" },
];

export default function TaskScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { rows, run } = useStore();
  const [asking, setAsking] = useState(false);
  const task = rows.tasks.find(candidate => candidate.id === id);
  if (!task) return <Missing />;

  const plan = planFor(rows, task.id);
  const action = latestTaskAction(rows, task.id);
  const done = isDone(task);
  const pending = isPending(action) || task.binding.kind === "pending";
  const title = taskTitle(rows, task);
  const jobs = jobsFor(rows, { taskId: task.id });
  const sourceUrl = task.observed?.sourceUrl;

  const facts = [
    { label: "List", value: listName(rows, task) },
    { label: "Status", value: pending ? "Saving to Google" : done ? "Done" : "Open" },
    task.observed?.doOn ? { label: "Do on", value: dayLabel(task.observed.doOn) } : null,
    plan?.deadlineOn ? { label: "Deadline", value: dayLabel(plan.deadlineOn) } : null,
    plan?.plannedAt ? { label: "Planned", value: whenLabel(plan.plannedAt) } : plan?.plannedOn ? { label: "Planned", value: dayLabel(plan.plannedOn) } : null,
    plan?.estimateMinutes ? { label: "Estimate", value: `${plan.estimateMinutes} min` } : null,
  ].filter((fact): fact is { label: string; value: string } => fact !== null);

  const savePlan = (current: TaskPlanRow, change: Partial<Pick<TaskPlanRow, "priority" | "waiting">>) => {
    void run(async () => expectOk(await requestTaskPlan(task.id, {
      version: current.version,
      priority: change.priority ?? current.priority,
      waiting: change.waiting ?? current.waiting,
      deadlineOn: current.deadlineOn,
      plannedOn: current.plannedOn,
      plannedAt: current.plannedAt,
      estimateMinutes: current.estimateMinutes,
    }), "Could not save the plan"));
  };

  const handOver = async (text: string) => {
    const ok = await run(() => createJob({ idempotencyKey: randomKey(), title: oneLine(title, 200), instruction: text, taskId: task.id }), "Handed to Hermes");
    if (ok) setAsking(false);
    return ok;
  };

  return (
    <Screen>
      <T size="title" bold>{title}</T>
      <Panel>{facts.map(fact => <Fact key={fact.label} label={fact.label} value={fact.value} />)}</Panel>
      {task.observed?.notes ? <Panel><T size="small" tone="muted">{task.observed.notes}</T></Panel> : null}
      {isStuck(action) ? <T size="small" tone="amber" style={styles.gap}>{action?.error ?? "Google didn't take that change"}</T> : null}

      {plan ? (
        <View style={styles.chips}>
          {priorities.map(option => (
            <Chip key={option.value} label={option.label} on={plan.priority === option.value} onPress={() => savePlan(plan, { priority: option.value })} />
          ))}
          <Chip label="Waiting" on={plan.waiting} onPress={() => savePlan(plan, { waiting: !plan.waiting })} />
        </View>
      ) : null}

      <Actions>
        <Button
          label={done ? "Reopen" : "Done"}
          tone="primary"
          disabled={pending || !canTick(task)}
          onPress={() => { void run(tickTask(task, done)); }}
        />
        {!asking ? <Button label="Hand to Hermes" onPress={() => setAsking(true)} /> : null}
        {sourceUrl ? <Button label="Open in Google" tone="quiet" onPress={() => { void Linking.openURL(sourceUrl); }} /> : null}
      </Actions>
      {asking ? <Composer placeholder="What should Hermes do?" submitLabel="Hand over" onSubmit={handOver} onCancel={() => setAsking(false)} /> : null}

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
  gap: { marginTop: space.md },
  chips: { flexDirection: "row", flexWrap: "wrap", gap: space.sm, marginTop: space.md },
});
