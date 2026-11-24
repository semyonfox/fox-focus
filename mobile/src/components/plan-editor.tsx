import { dublinDateTimeToInstant, dublinTimeValue } from "@shared/calendar-time";
import type { TaskPlanRow } from "@shared/row-model";
import { ChevronLeft, ChevronRight } from "lucide-react-native";
import { useState } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { addDays, dayLabel, dublinDateKey } from "@/lib/dates";
import { colors, radius, space } from "@/lib/theme";
import { Actions, Button, Chip, T } from "./ui";

export type PlanFields = Pick<TaskPlanRow, "deadlineOn" | "plannedOn" | "plannedAt" | "estimateMinutes">;

const estimates = [15, 30, 45, 60, 90, 120, 180, 240] as const;

// steps to the next preset either side, so an odd stored value still moves sensibly
function stepEstimate(current: number, direction: -1 | 1): number {
  const next = direction > 0 ? estimates.find(minutes => minutes > current) : [...estimates].reverse().find(minutes => minutes < current);
  return next ?? current;
}

const estimateLabel = (minutes: number) => minutes < 60 ? `${minutes} min` : minutes % 60 ? `${Math.floor(minutes / 60)} h ${minutes % 60}` : `${minutes / 60} h`;

function shiftTime(time: string, minutes: number): string {
  const total = (Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5)) + minutes + 1440) % 1440;
  return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
}

function Stepper({ label, value, onStep }: { label: string; value: string; onStep: (direction: -1 | 1) => void }) {
  return (
    <View style={styles.stepper}>
      <Pressable accessibilityRole="button" accessibilityLabel={`Earlier ${label}`} hitSlop={4} style={styles.step} onPress={() => onStep(-1)}>
        <ChevronLeft size={18} color={colors.muted} />
      </Pressable>
      <T size="small" style={styles.stepValue} accessibilityLiveRegion="polite">{value}</T>
      <Pressable accessibilityRole="button" accessibilityLabel={`Later ${label}`} hitSlop={4} style={styles.step} onPress={() => onStep(1)}>
        <ChevronRight size={18} color={colors.muted} />
      </Pressable>
    </View>
  );
}

export function DayField({ label, value, onChange }: { label: string; value: string | null; onChange: (value: string | null) => void }) {
  return (
    <View style={styles.field}>
      <T size="small" tone="faint" style={styles.label}>{label}</T>
      {value ? (
        <>
          <Stepper label={label.toLowerCase()} value={dayLabel(value)} onStep={direction => onChange(addDays(value, direction))} />
          <Chip label="Clear" on={false} onPress={() => onChange(null)} />
        </>
      ) : (
        <>
          <Chip label="Today" on={false} onPress={() => onChange(dublinDateKey())} />
          <Chip label="Tomorrow" on={false} onPress={() => onChange(addDays(dublinDateKey(), 1))} />
        </>
      )}
    </View>
  );
}

// planned day, optional Dublin time, deadline and estimate; the server keeps one of plannedOn or plannedAt
export function PlanEditor({ plan, onSave }: { plan: PlanFields; onSave: (next: PlanFields) => Promise<boolean> }) {
  const initialDay = plan.plannedAt ? dublinDateKey(new Date(plan.plannedAt)) : plan.plannedOn;
  const initialTime = plan.plannedAt ? dublinTimeValue(plan.plannedAt) : null;
  const [day, setDay] = useState(initialDay);
  const [time, setTime] = useState(initialTime);
  const [deadline, setDeadline] = useState(plan.deadlineOn);
  const [estimate, setEstimate] = useState(plan.estimateMinutes);
  const [busy, setBusy] = useState(false);

  const plannedAt = day === initialDay && time === initialTime
    ? plan.plannedAt
    : day && time ? dublinDateTimeToInstant(day, time) : null;
  // a wall time inside the spring-forward gap or the repeated autumn hour has no single instant
  const ambiguous = Boolean(day && time && !plannedAt);
  const dirty = day !== initialDay || time !== initialTime || deadline !== plan.deadlineOn || estimate !== plan.estimateMinutes;

  const save = async () => {
    setBusy(true);
    await onSave({ plannedOn: day && !time ? day : null, plannedAt, deadlineOn: deadline, estimateMinutes: estimate });
    setBusy(false);
  };

  return (
    <View style={styles.editor}>
      <DayField label="Plan" value={day} onChange={value => { setDay(value); if (!value) setTime(null); }} />
      {day ? (
        <View style={styles.field}>
          <T size="small" tone="faint" style={styles.label}>Time</T>
          {time ? (
            <>
              <Stepper label="time" value={time} onStep={direction => setTime(shiftTime(time, direction * 30))} />
              <Chip label="Any time" on={false} onPress={() => setTime(null)} />
            </>
          ) : <Chip label="Set a time" on={false} onPress={() => setTime(day === dublinDateKey() ? shiftTime(dublinTimeValue(new Date()).slice(0, 3) + "00", 60) : "09:00")} />}
        </View>
      ) : null}
      <DayField label="Deadline" value={deadline} onChange={setDeadline} />
      <View style={styles.field}>
        <T size="small" tone="faint" style={styles.label}>Estimate</T>
        {estimate !== null ? (
          <>
            <Stepper label="estimate" value={estimateLabel(estimate)} onStep={direction => setEstimate(stepEstimate(estimate, direction))} />
            <Chip label="Clear" on={false} onPress={() => setEstimate(null)} />
          </>
        ) : <Chip label="Set" on={false} onPress={() => setEstimate(30)} />}
      </View>
      {ambiguous ? <T size="small" tone="amber">That time doesn't exist once in Dublin on this day. Pick another.</T> : null}
      {dirty ? (
        <Actions>
          <Button label={busy ? "Saving…" : "Save plan"} tone="primary" disabled={busy || ambiguous} onPress={() => { void save(); }} />
          <Button label="Undo" tone="quiet" disabled={busy} onPress={() => { setDay(initialDay); setTime(initialTime); setDeadline(plan.deadlineOn); setEstimate(plan.estimateMinutes); }} />
        </Actions>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  editor: { marginTop: space.md, gap: space.xs },
  field: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: space.sm },
  label: { width: 64 },
  stepper: {
    flexDirection: "row", alignItems: "center", minHeight: 48, borderRadius: radius,
    borderWidth: 1, borderColor: colors.line,
  },
  step: { width: 40, minHeight: 46, alignItems: "center", justifyContent: "center" },
  stepValue: { minWidth: 72, textAlign: "center" },
});
