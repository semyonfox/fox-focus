import type { CalendarEntry } from "@shared/calendar-layout";
import { minuteOfDay } from "@shared/calendar-layout";
import { addCalendarDays, calendarDateWindow, dublinDateKey, dublinTimeValue, formatDublinDateKey } from "@shared/calendar-time";
import { createJob } from "@shared/inbox-client";
import { router } from "expo-router";
import { ChevronLeft, ChevronRight } from "lucide-react-native";
import { useEffect, useState } from "react";
import { Pressable, RefreshControl, ScrollView, StyleSheet, View } from "react-native";
import { DayGrid } from "@/components/day-grid";
import { DockScene } from "@/components/dock";
import { ConnectPrompt } from "@/components/status-line";
import { Actions, Button, Chip, Composer, Panel, Section, T } from "@/components/ui";
import { oneLine, randomKey } from "@/lib/api";
import { assistantName } from "@shared/work-threads";
import { assistantAvailable, calendarFor, defaultAssistant, entryTaskId, isAllDayOn, timedOn } from "@/lib/derive";
import { useDock } from "@/lib/dock";
import { useStore } from "@/lib/store";
import { areaColors, colors, radius, space } from "@/lib/theme";

type Mode = "day" | "agenda";

const agendaDays = 14;

function durationLabel(minutes: number): string {
  const rounded = Math.round(minutes);
  if (rounded < 60) return `${rounded} min`;
  const hours = Math.floor(rounded / 60);
  const rest = rounded % 60;
  return rest ? `${hours} h ${rest} min` : `${hours} h`;
}

function timing(entry: CalendarEntry): string {
  if (entry.allDay) {
    return entry.endDate ? `All day · until ${formatDublinDateKey(addCalendarDays(entry.endDate, -1), { day: "numeric", month: "short" })}` : "All day";
  }
  const end = entry.startsAt
    ? dublinTimeValue(new Date(Date.parse(entry.startsAt) + entry.duration * 60_000))
    : null;
  return `${entry.time}${end ? `–${end}` : ""} · ${durationLabel(entry.duration)}`;
}

function useNow() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 30_000);
    return () => clearInterval(timer);
  }, []);
  return now;
}

export default function CalendarScreen() {
  const { rows, calendar, connection, ready, loading, refresh, run, actionError, loadedAt } = useStore();
  const dock = useDock();
  const now = useNow();
  const today = dublinDateKey(now);
  const [date, setDate] = useState(today);
  const [mode, setMode] = useState<Mode>("day");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [asking, setAsking] = useState(false);

  if (ready && !connection) {
    return (
      <DockScene tab="calendar">
        <View style={styles.page}><View style={styles.head}><ConnectPrompt /></View></View>
      </DockScene>
    );
  }

  const entries = calendarFor(rows, calendar, today);
  const selected = entries.find(entry => entry.id === selectedId) ?? null;
  const week = calendarDateWindow(addCalendarDays(date, -new Date(`${date}T12:00:00Z`).getUTCDay()), 0, 6);
  const allDay = entries.filter(entry => isAllDayOn(entry, date));
  const pick = (next: string) => { setDate(next); setSelectedId(null); setAsking(false); };
  const select = (entry: CalendarEntry) => { setSelectedId(entry.id); setAsking(false); };

  const ask = async (text: string) => {
    if (!selected) return false;
    const context = `${selected.title} · ${formatDublinDateKey(selected.date)} · ${timing(selected)} · ${selected.source} · Calendar record ${selected.id}`;
    const assistant = defaultAssistant(rows, false);
    const ok = await run(() => createJob({
      idempotencyKey: randomKey(), title: oneLine(`Review ${selected.title}`, 200),
      instruction: `${text}\n\nContext: ${context}`.slice(0, 2000), assistant,
    }), `Handed to ${assistantName(assistant)}`);
    if (ok) setAsking(false);
    return ok;
  };

  const agenda = calendarDateWindow(date, 0, agendaDays - 1).map(day => ({
    day,
    allDay: entries.filter(entry => isAllDayOn(entry, day)),
    timed: timedOn(entries, day),
  })).filter(group => group.allDay.length || group.timed.length);

  const entryRow = (entry: CalendarEntry, label: string) => (
    <Pressable key={entry.id} accessibilityRole="button" onPress={() => select(entry)} style={({ pressed }) => [styles.row, pressed && styles.pressed]}>
      <View style={[styles.bar, { backgroundColor: areaColors[entry.area] }]} />
      <T size="small" tone="muted" style={styles.rowTime}>{label}</T>
      <View style={styles.grow}>
        <T numberOfLines={1}>{entry.title}</T>
        <T size="tiny" tone="faint" numberOfLines={1}>{entry.source}</T>
      </View>
    </Pressable>
  );

  return (
    <DockScene tab="calendar">
      <View style={styles.page}>
        <View style={styles.head}>
          {actionError ? <T tone="amber" accessibilityRole="alert" accessibilityLiveRegion="polite">{actionError}</T> : null}
          <View style={styles.titleRow}>
            <T size="title" bold accessibilityRole="header" accessibilityLiveRegion="polite" style={styles.grow}>
              {formatDublinDateKey(date, { weekday: "short", day: "numeric", month: "short", ...(date.slice(0, 4) === today.slice(0, 4) ? {} : { year: "numeric" }) })}
            </T>
            {date !== today ? <Button label="Today" tone="quiet" onPress={() => pick(today)} /> : null}
            <Chip label="Day" on={mode === "day"} onPress={() => setMode("day")} />
            <Chip label="Agenda" on={mode === "agenda"} onPress={() => setMode("agenda")} />
          </View>
          <View style={styles.strip}>
            <Pressable accessibilityRole="button" accessibilityLabel="Previous week" hitSlop={4} style={styles.step} onPress={() => pick(addCalendarDays(date, -7))}>
              <ChevronLeft size={20} color={colors.muted} />
            </Pressable>
            {week.map(day => {
              const on = day === date;
              const marked = entries.some(entry => isAllDayOn(entry, day)) || timedOn(entries, day).length > 0;
              return (
                <Pressable
                  key={day}
                  accessibilityRole="button"
                  accessibilityLabel={formatDublinDateKey(day, { weekday: "long", day: "numeric", month: "long" })}
                  accessibilityState={{ selected: on }}
                  onPress={() => pick(day)}
                  style={[styles.day, on && styles.dayOn]}
                >
                  <T size="tiny" tone={on ? "page" : "faint"}>{formatDublinDateKey(day, { weekday: "narrow" })}</T>
                  <T size="small" bold tone={on ? "page" : day === today ? "amber" : "text"}>{String(Number(day.slice(8)))}</T>
                  <View style={[styles.mark, marked && { backgroundColor: on ? colors.page : colors.faint }]} />
                </Pressable>
              );
            })}
            <Pressable accessibilityRole="button" accessibilityLabel="Next week" hitSlop={4} style={styles.step} onPress={() => pick(addCalendarDays(date, 7))}>
              <ChevronRight size={20} color={colors.muted} />
            </Pressable>
          </View>
          {calendar.failed && loadedAt ? <T size="small" tone="amber">Calendar sources could not refresh. Showing what loaded.</T> : null}
          {mode === "day" && allDay.length ? (
            <View style={styles.allDay}>
              {allDay.map(entry => (
                <Pressable key={entry.id} onPress={() => select(entry)} accessibilityRole="button" style={[styles.allDayChip, { borderLeftColor: areaColors[entry.area] }]}>
                  <T size="small" numberOfLines={1}>{entry.title}</T>
                </Pressable>
              ))}
            </View>
          ) : null}
        </View>

        {mode === "day" ? (
          <DayGrid
            entries={entries}
            day={date}
            nowMinute={date === today ? minuteOfDay(dublinTimeValue(now)) : null}
            selectedId={selectedId}
            onSelect={select}
          />
        ) : (
          <ScrollView
            style={styles.grow}
            contentContainerStyle={styles.agenda}
            onScroll={dock.onScroll}
            scrollEventThrottle={16}
            refreshControl={<RefreshControl refreshing={loading} onRefresh={refresh} tintColor={colors.muted} colors={[colors.page]} progressBackgroundColor={colors.accent} />}
          >
            {agenda.map(group => (
              <View key={group.day}>
                <Section title={formatDublinDateKey(group.day, { weekday: "short", day: "numeric", month: "short" })} />
                {group.allDay.map(entry => entryRow(entry, "All day"))}
                {group.timed.map(({ entry, start }) => entryRow(entry, entry.date < group.day && start === 0 ? "Cont." : entry.time))}
              </View>
            ))}
            {!agenda.length ? <T size="small" tone="faint" style={styles.empty}>{!loadedAt ? "Loading calendar…" : `Nothing in the next ${agendaDays} days`}</T> : null}
          </ScrollView>
        )}

        {selected ? (
          <View style={styles.sheet}>
            <Panel style={styles.sheetPanel}>
              <T size="tiny" tone="faint" bold>{selected.source.toUpperCase()}</T>
              <T bold>{selected.title}</T>
              <T size="small" tone="muted">{`${formatDublinDateKey(selected.date, { weekday: "short", day: "numeric", month: "short" })} · ${timing(selected)} · ${selected.area}`}</T>
              {asking ? (
                <Composer label="Request" placeholder={`What should ${assistantName(defaultAssistant(rows, false))} do?`} submitLabel="Hand over" onSubmit={ask} onCancel={() => setAsking(false)} />
              ) : (
                <Actions>
                  {entryTaskId(selected) ? (
                    <Button label="Open task" tone="primary" onPress={() => { const id = entryTaskId(selected); if (id) router.push({ pathname: "/task/[id]", params: { id } }); }} />
                  ) : (
                    <Button label="Ask" disabled={!assistantAvailable(rows, "fox") && !assistantAvailable(rows, "hermes")} onPress={() => setAsking(true)} />
                  )}
                  <Button label="Close" tone="quiet" onPress={() => setSelectedId(null)} />
                </Actions>
              )}
              {!selected.local?.editable ? <T size="tiny" tone="faint" style={styles.note}>Read-only</T> : null}
            </Panel>
          </View>
        ) : null}
      </View>
    </DockScene>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: colors.page },
  head: { paddingHorizontal: space.lg, paddingTop: space.sm, gap: space.sm },
  titleRow: { flexDirection: "row", alignItems: "center", gap: space.sm, minHeight: 48 },
  grow: { flex: 1 },
  strip: { flexDirection: "row", alignItems: "center" },
  step: { width: 32, minHeight: 48, alignItems: "center", justifyContent: "center" },
  day: { flex: 1, alignItems: "center", paddingVertical: 6, borderRadius: radius, minHeight: 48 },
  dayOn: { backgroundColor: colors.accent },
  mark: { width: 4, height: 4, borderRadius: 2, marginTop: 2 },
  allDay: { gap: space.xs },
  allDayChip: {
    backgroundColor: colors.panel, borderColor: colors.line, borderWidth: 1, borderLeftWidth: 3, borderRadius: 6,
    paddingVertical: 6, paddingHorizontal: space.sm, minHeight: 36, justifyContent: "center",
  },
  agenda: { paddingHorizontal: space.lg, paddingBottom: 120 },
  row: {
    flexDirection: "row", alignItems: "center", gap: space.md, paddingVertical: 10, minHeight: 48,
    borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.lineSoft,
  },
  pressed: { opacity: 0.7 },
  bar: { width: 3, alignSelf: "stretch", borderRadius: 2 },
  rowTime: { width: 52 },
  empty: { marginTop: space.xl },
  sheet: { position: "absolute", left: space.lg, right: space.lg, bottom: 96 },
  sheetPanel: { backgroundColor: colors.panelMuted, gap: 2 },
  note: { marginTop: space.xs },
});
