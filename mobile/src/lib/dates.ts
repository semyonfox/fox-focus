const zone = "Europe/Dublin";

const pad = (value: number) => String(value).padStart(2, "0");

export function dublinDateKey(date = new Date()): string {
  // en-CA formats as YYYY-MM-DD
  return new Intl.DateTimeFormat("en-CA", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
}

export function addDays(key: string, days: number): string {
  const date = new Date(`${key}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

export function dayLabel(key: string, today = dublinDateKey()): string {
  if (key === today) return "Today";
  if (key === addDays(today, 1)) return "Tomorrow";
  if (key === addDays(today, -1)) return "Yesterday";
  const date = new Date(`${key}T12:00:00Z`);
  if (key > today && key < addDays(today, 7)) {
    return new Intl.DateTimeFormat("en-IE", { timeZone: "UTC", weekday: "short" }).format(date);
  }
  return new Intl.DateTimeFormat("en-IE", {
    timeZone: "UTC",
    day: "numeric",
    month: "short",
    ...(key.slice(0, 4) === today.slice(0, 4) ? {} : { year: "numeric" }),
  }).format(date);
}

export function timeLabel(instant: string): string {
  return new Intl.DateTimeFormat("en-IE", { timeZone: zone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(instant));
}

export function whenLabel(instant: string): string {
  return `${dayLabel(dublinDateKey(new Date(instant)))} ${timeLabel(instant)}`;
}

function dublinOffsetMinutes(date: Date): number {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-GB", {
      timeZone: zone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
    }).formatToParts(date).map(part => [part.type, part.value]),
  );
  const asUtc = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour), Number(parts.minute));
  return Math.round((asUtc - date.getTime()) / 60_000);
}

// utc instant for a wall-clock hour in Dublin on the given day
export function dublinInstant(key: string, hour: number): string {
  const guess = new Date(`${key}T${pad(hour)}:00:00Z`);
  return new Date(guess.getTime() - dublinOffsetMinutes(guess) * 60_000).toISOString();
}

export function tomorrowMorning(now = new Date()): string {
  return dublinInstant(addDays(dublinDateKey(now), 1), 9);
}
