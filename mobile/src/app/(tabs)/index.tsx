import { minuteOfDay } from "@shared/calendar-layout";
import { dublinTimeValue } from "@shared/calendar-time";
import { router } from "expo-router";
import { Pressable, StyleSheet, View } from "react-native";
import { DockScene } from "@/components/dock";
import { BriefingCard } from "@/components/briefing";
import { TaskItem, ThreadItem } from "@/components/rows";
import { ConnectPrompt, StatusLine } from "@/components/status-line";
import { Button, Screen, Section, T } from "@/components/ui";
import { addDays, dublinDateKey } from "@/lib/dates";
import { calendarFor, entryTaskId, isAllDayOn, openTasks, threads, timedOn, whenKey } from "@/lib/derive";
import { useStore } from "@/lib/store";
import { areaColors, colors, space } from "@/lib/theme";
import { UpdateBanner } from "@/lib/updates";

export default function Today() {
  const { rows, calendar, connection, ready } = useStore();
  if (ready && !connection) {
    return (
      <DockScene tab="index">
        <Screen>
          <UpdateBanner />
          <ConnectPrompt />
        </Screen>
      </DockScene>
    );
  }

  const today = dublinDateKey();
  const open = openTasks(rows);
  const next = open.slice(0, 5);
  const soon = open.slice(5).filter(task => {
    const key = whenKey(rows, task);
    return key !== null && key <= addDays(today, 3);
  }).slice(0, 5);
  const needs = threads(rows).filter(thread => thread.attention);
  const entries = calendarFor(rows, calendar, today);
  const nowMinute = minuteOfDay(dublinTimeValue(new Date()));
  const upcoming = timedOn(entries, today).filter(slot => slot.end > nowMinute).slice(0, 3);
  const allDay = entries.filter(entry => isAllDayOn(entry, today));

  return (
    <DockScene tab="index">
      <Screen>
        <UpdateBanner />
        <StatusLine />

        <Section title="Needs you" count={needs.length} />
        {needs.length ? needs.slice(0, 3).map(thread => <ThreadItem key={thread.key} thread={thread} />) : <T size="small" tone="faint">Nothing waiting</T>}
        {needs.length > 3 ? <Button label={`All ${needs.length}`} tone="quiet" onPress={() => router.push("/inbox")} /> : null}

        <Section
          title={upcoming.some(slot => slot.start <= nowMinute) ? "Now and next" : "Next today"}
          action={
            <Pressable accessibilityRole="button" style={styles.link} onPress={() => router.push("/calendar")}>
              <T size="tiny" tone="muted">Calendar</T>
            </Pressable>
          }
        />
        {allDay.length ? <T size="small" tone="faint" numberOfLines={1}>{`All day · ${allDay.map(entry => entry.title).join(", ")}`}</T> : null}
        {upcoming.length ? upcoming.map(({ entry, start }) => {
          const taskId = entryTaskId(entry);
          return (
            <Pressable
              key={entry.id}
              accessibilityRole="button"
              onPress={() => taskId ? router.push({ pathname: "/task/[id]", params: { id: taskId } }) : router.push("/calendar")}
              style={({ pressed }) => [styles.event, pressed && styles.pressed]}
            >
              <View style={[styles.bar, { backgroundColor: areaColors[entry.area] }]} />
              <T size="small" tone={start <= nowMinute ? "amber" : "muted"} style={styles.time}>{start <= nowMinute ? "Now" : entry.time}</T>
              <View style={styles.grow}>
                <T numberOfLines={1}>{entry.title}</T>
                <T size="tiny" tone="faint" numberOfLines={1}>{entry.source}</T>
              </View>
            </Pressable>
          );
        }) : <T size="small" tone="faint">Nothing else on today</T>}

        <BriefingCard />

        <Section title="Next up" count={open.length} />
        {next.length ? next.map(task => <TaskItem key={task.id} task={task} />) : <T size="small" tone="faint">All clear</T>}

        {soon.length ? (
          <>
            <Section title="Due soon" />
            {soon.map(task => <TaskItem key={task.id} task={task} />)}
          </>
        ) : null}
      </Screen>
    </DockScene>
  );
}

const styles = StyleSheet.create({
  event: {
    flexDirection: "row", alignItems: "center", gap: space.md, paddingVertical: 10, minHeight: 48,
    borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.lineSoft,
  },
  pressed: { opacity: 0.7 },
  link: { minHeight: 48, minWidth: 48, justifyContent: "center", alignItems: "flex-end" },
  bar: { width: 3, alignSelf: "stretch", borderRadius: 2 },
  time: { width: 52 },
  grow: { flex: 1 },
});
