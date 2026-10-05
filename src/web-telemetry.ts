import { browserTelemetryAllowed, createTelemetry, telemetryPreferenceKey } from "./telemetry.ts";

let sessionAllowed = true;

export function setTelemetryAllowed(enabled: boolean): boolean {
  sessionAllowed = enabled;
  try { window.localStorage.setItem(telemetryPreferenceKey, String(enabled)); }
  catch { sessionAllowed = false; }
  return sessionAllowed && browserTelemetryAllowed();
}

export const telemetry = createTelemetry({
  enabled: import.meta.env.VITE_ANONYMOUS_STATS_ENABLED === "true",
  endpoint: import.meta.env.VITE_ANONYMOUS_STATS_ENDPOINT,
  surface: "web",
}, { allowed: () => sessionAllowed && browserTelemetryAllowed() });
