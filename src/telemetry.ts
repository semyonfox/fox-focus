export type TelemetryRoute = "app" | "home" | "workspace" | "settings";
type CountName = "app_open" | "screen_view" | "action_completed" | "action_failed";
type ErrorName = "unexpected_error" | "request_failed" | "render_failed" | "storage_failed" | "permission_failed" | "media_failed" | "validation_failed";
type Event = { kind: "count"; name: CountName } | { kind: "error"; name: ErrorName };

export type TelemetryConfig = { enabled?: boolean; endpoint?: string; surface?: "web" | "android" };
export type TelemetryEnvironment = {
  allowed: () => boolean;
  fetch?: typeof fetch;
  now?: () => number;
  controller?: () => AbortController;
  schedule?: (callback: () => void, milliseconds: number) => ReturnType<typeof setTimeout>;
  cancel?: (timer: ReturnType<typeof setTimeout>) => void;
};

const counts: readonly string[] = ["app_open", "screen_view", "action_completed", "action_failed"];
const errors: readonly string[] = ["unexpected_error", "request_failed", "render_failed", "storage_failed", "permission_failed", "media_failed", "validation_failed"];
const routes: readonly string[] = ["app", "home", "workspace", "settings"];

function validEndpoint(endpoint: string | undefined): endpoint is string {
  if (!endpoint || /[?#\\\s]/.test(endpoint)) return false;
  if (endpoint.startsWith("/") && !endpoint.startsWith("//")) return endpoint.endsWith("/v1/events");
  try {
    const url = new URL(endpoint);
    return url.protocol === "https:" && !url.username && !url.password && url.pathname.endsWith("/v1/events");
  } catch { return false; }
}

export function createTelemetry(config: TelemetryConfig, environment: TelemetryEnvironment) {
  const configured = config.enabled === true && validEndpoint(config.endpoint) &&
    (config.surface === undefined || config.surface === "web" || config.surface === "android");
  const endpoint = config.endpoint;
  const surface = config.surface ?? "web";
  let total = 0;
  let inFlight = false;
  let recent: number[] = [];
  const lastErrors = new Map<ErrorName, number>();

  function emit(event: Event, route: TelemetryRoute = "app"): void {
    try {
      if (!configured || !endpoint || !environment.allowed() || inFlight || total >= 200) return;
      if (!routes.includes(route) || !(event.kind === "count" ? counts : event.kind === "error" ? errors : []).includes(event.name)) return;
      const now = (environment.now ?? Date.now)();
      if (!Number.isFinite(now)) return;
      recent = recent.filter(time => now - time < 60_000);
      if (recent.length >= 20) return;
      if (event.kind === "error" && now - (lastErrors.get(event.name) ?? -Infinity) < 60_000) return;
      const controller = (environment.controller ?? (() => new AbortController()))();
      const cancel = environment.cancel ?? clearTimeout;
      let timer: ReturnType<typeof setTimeout> | undefined;
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        inFlight = false;
        try { if (timer !== undefined) cancel(timer); } catch { /* optional transport cleanup */ }
      };
      timer = (environment.schedule ?? setTimeout)(() => {
        try { controller.abort(); } catch { /* a failed abort still releases the bounded request */ }
        finish();
      }, 2_000);
      if (!environment.allowed()) { finish(); return; }
      inFlight = true;
      total++;
      recent.push(now);
      if (event.kind === "error") lastErrors.set(event.name, now);
      const body = JSON.stringify({ version: 1, app: "fox-focus", kind: event.kind, name: event.name, surface, route });
      try {
        void Promise.resolve((environment.fetch ?? fetch)(endpoint, {
          method: "POST", headers: { "Content-Type": "application/json" }, body,
          credentials: "omit", referrerPolicy: "no-referrer", redirect: "error", signal: controller.signal,
        })).catch(() => {}).finally(finish);
      } catch { finish(); }
    } catch { /* observability must never interrupt the application */ }
  }
  return { configured, emit };
}

export const telemetryPreferenceKey = "fox-focus-anonymous-stats";

export function browserTelemetryAllowed(): boolean {
  try {
    const privacy = navigator as Navigator & { globalPrivacyControl?: boolean };
    const preference = window.localStorage.getItem(telemetryPreferenceKey);
    return privacy.globalPrivacyControl !== true && !["1", "yes"].includes(navigator.doNotTrack ?? "") &&
      (preference === null || preference === "true");
  } catch { return false; }
}
