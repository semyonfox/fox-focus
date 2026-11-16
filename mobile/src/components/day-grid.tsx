import type { CalendarEntry } from "@shared/calendar-layout";
import { layoutDay } from "@shared/calendar-layout";
import { useEffect, useRef, useState } from "react";
import { Pressable, RefreshControl, ScrollView, StyleSheet, View, type LayoutChangeEvent, type ScrollViewInstance } from "react-native";
import { useDockScroll } from "@/lib/dock";
import { useStore } from "@/lib/store";
import { areaColors, colors, nowColor, space } from "@/lib/theme";
import { T } from "./ui";

const hourHeight = 52;
const gutter = 44;
const px = (minutes: number) => (minutes / 60) * hourHeight;

// one Dublin day as a 24-hour grid; overlapping entries share the width like the web calendar
export function DayGrid({ entries, day, nowMinute, selectedId, onSelect }: {
  entries: readonly CalendarEntry[];
  day: string;
  nowMinute: number | null;
  selectedId: string | null;
  onSelect: (entry: CalendarEntry) => void;
}) {
  const scroller = useRef<ScrollViewInstance>(null);
  const onDockScroll = useDockScroll();
  const { loading, refresh } = useStore();
  const [width, setWidth] = useState(0);
  const slots = layoutDay(entries.filter(entry => !entry.allDay), day);
  const firstStart = slots[0]?.start ?? 8 * 60;
  // today opens on the current time and stays put as it ticks; other days follow their first entry as it loads
  const anchorKey = nowMinute !== null ? -1 : firstStart;
  useEffect(() => {
    const anchor = nowMinute ?? firstStart;
    scroller.current?.scrollTo({ y: Math.max(0, px(anchor) - 2 * hourHeight), animated: false });
  }, [day, anchorKey]);

  return (
    <ScrollView ref={scroller} style={styles.scroll} contentContainerStyle={styles.content} onScroll={onDockScroll} scrollEventThrottle={16}
      refreshControl={<RefreshControl refreshing={loading} onRefresh={refresh} tintColor={colors.muted} colors={[colors.page]} progressBackgroundColor={colors.accent} />}>
      <View style={{ height: 24 * hourHeight }} onLayout={(event: LayoutChangeEvent) => setWidth(event.nativeEvent.layout.width - gutter)}>
        {Array.from({ length: 24 }, (_, hour) => (
          <View key={hour} style={[styles.hour, { top: hour * hourHeight }]}>
            <T size="tiny" tone="faint" style={styles.hourLabel}>{`${String(hour).padStart(2, "0")}:00`}</T>
            <View style={styles.hourLine} />
          </View>
        ))}
        {width > 0 ? slots.map(({ entry, start, end, column, columns }) => {
          const height = Math.max(24, px(end - start) - 2);
          const colour = areaColors[entry.area];
          const selected = entry.id === selectedId;
          return (
            <Pressable
              key={entry.id}
              accessibilityRole="button"
              accessibilityLabel={`${entry.title}, ${entry.time}, ${entry.source}`}
              onPress={() => onSelect(entry)}
              style={[styles.event, {
                top: px(start), height,
                left: gutter + (column / columns) * width + 2,
                width: width / columns - 4,
                borderLeftColor: colour,
                borderColor: selected ? colour : colors.line,
                backgroundColor: selected ? colors.panelMuted : colors.panel,
              }]}
            >
              <T size="small" bold numberOfLines={height >= 44 ? 2 : 1}>{entry.title}</T>
              {height >= 40 ? <T size="tiny" tone="muted" numberOfLines={1}>{entry.time}</T> : null}
            </Pressable>
          );
        }) : null}
        {nowMinute !== null ? (
          <View pointerEvents="none" style={[styles.now, { top: px(nowMinute) }]}>
            <View style={styles.nowDot} />
          </View>
        ) : null}
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  scroll: { flex: 1 },
  content: { paddingHorizontal: space.lg, paddingTop: space.sm, paddingBottom: 120 },
  hour: { position: "absolute", left: 0, right: 0, flexDirection: "row", alignItems: "flex-start" },
  hourLabel: { width: gutter, marginTop: -7 },
  hourLine: { flex: 1, height: StyleSheet.hairlineWidth, backgroundColor: colors.lineSoft },
  event: {
    position: "absolute", overflow: "hidden", borderWidth: 1, borderLeftWidth: 3, borderRadius: 6,
    paddingVertical: 3, paddingHorizontal: 6,
  },
  now: { position: "absolute", left: gutter, right: 0, height: 2, backgroundColor: nowColor },
  nowDot: { position: "absolute", left: -5, top: -4, width: 10, height: 10, borderRadius: 5, backgroundColor: nowColor },
});
