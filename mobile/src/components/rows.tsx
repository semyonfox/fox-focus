import { requestTaskStatus } from "@shared/row-client";
import type { TaskRow } from "@shared/row-model";
import { relativeTime, type WorkThread } from "@shared/work-threads";
import { router } from "expo-router";
import { Pressable, StyleSheet, View } from "react-native";
import { expectOk } from "@/lib/api";
import { dublinDateKey } from "@/lib/dates";
import {
  canTick, dueLabel, isDone, isPending, isStuck, latestTaskAction, listName, taskTitle, threadStatus, threadTone, whenKey,
} from "@/lib/derive";
import { useStore } from "@/lib/store";
import { colors, space } from "@/lib/theme";
import { Checkbox, Dot, T } from "./ui";

// the checkbox click is the approval; the server queues the Google change and the row shows it pending
export function tickTask(task: TaskRow, done: boolean) {
  return async () => expectOk(
    await requestTaskStatus(task.id, task.version, done ? "open" : "completed"),
    "Could not record the Google task change",
  );
}

export function TaskItem({ task }: { task: TaskRow }) {
  const { rows, run } = useStore();
  const action = latestTaskAction(rows, task.id);
  const pending = isPending(action) || task.binding.kind === "pending";
  const done = isDone(task);
  const when = whenKey(rows, task);
  const overdue = !done && when !== null && when < dublinDateKey();
  const meta = [listName(rows, task), dueLabel(rows, task)].filter(Boolean).join(" · ");
  return (
    <Pressable
      onPress={() => router.push({ pathname: "/task/[id]", params: { id: task.id } })}
      style={({ pressed }) => [styles.row, pressed && styles.pressed]}
    >
      <Checkbox
        checked={done}
        pending={pending}
        disabled={!canTick(task) || pending}
        onPress={() => { void run(tickTask(task, done)); }}
      />
      <View style={styles.body}>
        <T numberOfLines={2} tone={done ? "faint" : "text"} style={done ? styles.struck : undefined}>{taskTitle(rows, task)}</T>
        {meta ? <T size="small" tone={overdue ? "amber" : "faint"} numberOfLines={1}>{meta}</T> : null}
      </View>
      {isStuck(action) ? <Dot tone="amber" /> : null}
    </Pressable>
  );
}

export function ThreadItem({ thread }: { thread: WorkThread }) {
  const { rows } = useStore();
  const open = () => {
    if (thread.job) router.push({ pathname: "/job/[id]", params: { id: thread.job.id } });
    else if (thread.item) router.push({ pathname: "/inbox/[id]", params: { id: thread.item.id } });
  };
  return (
    <Pressable onPress={open} style={({ pressed }) => [styles.row, pressed && styles.pressed]}>
      <View style={styles.dotSlot}><Dot tone={threadTone(thread)} /></View>
      <View style={styles.body}>
        <T numberOfLines={1} tone={thread.group === "settled" ? "faint" : "text"}>{thread.title}</T>
        <T size="small" tone="faint" numberOfLines={1}>{`${thread.source} · ${threadStatus(rows, thread)}`}</T>
      </View>
      <T size="tiny" tone="faint">{relativeTime(thread.updatedAt)}</T>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.md,
    paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.lineSoft,
  },
  pressed: { opacity: 0.7 },
  body: { flex: 1 },
  struck: { textDecorationLine: "line-through" },
  dotSlot: { width: 22, alignItems: "center" },
});
