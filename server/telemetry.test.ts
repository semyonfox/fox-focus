import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { browserTelemetryAllowed, createTelemetry, type TelemetryConfig, type TelemetryEnvironment } from "../src/telemetry.ts";

const tick = () => new Promise<void>(resolve => setImmediate(resolve));
const config: TelemetryConfig = { enabled: true, endpoint: "/anonymous/v1/events" };

function fixture(overrides: Partial<TelemetryEnvironment> = {}, configuration = config) {
  const requests: { endpoint: string; options: RequestInit }[] = [];
  const client = createTelemetry(configuration, {
    allowed: () => true,
    fetch: async (endpoint, options) => { requests.push({ endpoint: String(endpoint), options: options ?? {} }); return new Response(null, { status: 204 }); },
    ...overrides,
  });
  return { client, requests };
}

test("telemetry defaults off and requires both explicit flag and safe owner endpoint", () => {
  for (const configuration of [{}, { endpoint: config.endpoint }, { enabled: true },
    { enabled: true, endpoint: "http://example.test/v1/events" },
    { enabled: true, endpoint: "//example.test/v1/events" },
    { enabled: true, endpoint: "https://user:secret@example.test/v1/events" },
    { enabled: true, endpoint: "https://example.test/v1/events?task=private" }]) {
    const { client, requests } = fixture({}, configuration);
    client.emit({ kind: "count", name: "app_open" });
    assert.equal(requests.length, 0);
  }
});

test("payload contains only fixed six fields, never private context, routes or errors", async () => {
  const privateFixture = { title: "private task fixture", id: "private-task-id", url: "https://private.example.test?token=fixture", message: "private error fixture" };
  const { client, requests } = fixture();
  client.emit({ kind: "count", name: "screen_view", ...privateFixture }, "workspace");
  await tick();
  client.emit({ kind: "error", name: "request_failed", ...privateFixture }, "workspace");
  await tick();
  Reflect.apply(client.emit, null, [{ kind: "count", name: "screen_view" }, privateFixture.url]);
  Reflect.apply(client.emit, null, [{ kind: "error", name: privateFixture.message }]);
  assert.equal(requests.length, 2);
  for (const request of requests) {
    const body = String(request.options.body);
    assert.deepEqual(Object.keys(JSON.parse(body)).sort(), ["version", "app", "kind", "name", "surface", "route"].sort());
    for (const value of Object.values(privateFixture)) assert.ok(!body.includes(value));
    assert.ok(Buffer.byteLength(body) <= 1024);
    assert.equal(request.options.credentials, "omit");
    assert.equal(request.options.referrerPolicy, "no-referrer");
    assert.equal(request.options.redirect, "error");
  }
});

test("privacy denial, unreadable privacy and late opt-out emit nothing", () => {
  for (const allowed of [() => false, () => { throw new Error("synthetic inaccessible preference"); }]) {
    const { client, requests } = fixture({ allowed });
    assert.doesNotThrow(() => client.emit({ kind: "count", name: "app_open" }));
    assert.equal(requests.length, 0);
  }
  let reads = 0;
  const { client, requests } = fixture({ allowed: () => ++reads === 1 });
  client.emit({ kind: "count", name: "app_open" });
  assert.equal(requests.length, 0);
});

test("browser privacy signals and boolean opt-out are fail closed", () => {
  const oldWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  const oldNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  try {
    for (const scenario of [
      { preference: null, globalPrivacyControl: false, doNotTrack: "0", expected: true },
      { preference: "false", globalPrivacyControl: false, doNotTrack: "0", expected: false },
      { preference: "true", globalPrivacyControl: true, doNotTrack: "0", expected: false },
      { preference: "true", globalPrivacyControl: false, doNotTrack: "1", expected: false },
      { preference: "corrupt", globalPrivacyControl: false, doNotTrack: "0", expected: false },
    ]) {
      Object.defineProperty(globalThis, "window", { configurable: true, value: { localStorage: { getItem: () => scenario.preference } } });
      Object.defineProperty(globalThis, "navigator", { configurable: true, value: scenario });
      assert.equal(browserTelemetryAllowed(), scenario.expected);
    }
    Object.defineProperty(globalThis, "window", { configurable: true, get: () => { throw new Error("synthetic storage denied"); } });
    assert.equal(browserTelemetryAllowed(), false);
  } finally {
    if (oldWindow) Object.defineProperty(globalThis, "window", oldWindow); else Reflect.deleteProperty(globalThis, "window");
    if (oldNavigator) Object.defineProperty(globalThis, "navigator", oldNavigator); else Reflect.deleteProperty(globalThis, "navigator");
  }
});

test("transport and browser capability failures never interrupt the app or retry", async () => {
  for (const overrides of [
    { fetch: () => { throw new Error("synthetic transport failure"); } },
    { fetch: async () => { throw new Error("synthetic rejection"); } },
    { controller: () => { throw new Error("synthetic unsupported controller"); } },
    { schedule: () => { throw new Error("synthetic timer failure"); } },
    { cancel: () => { throw new Error("synthetic cleanup failure"); } },
  ]) {
    const { client } = fixture(overrides);
    assert.doesNotThrow(() => client.emit({ kind: "count", name: "app_open" }));
    await tick();
  }
});

test("each send rechecks changed or unreadable browser privacy settings", async () => {
  const oldWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  const oldNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  let preference: string | null = null;
  let readable = true;
  try {
    Object.defineProperty(globalThis, "window", { configurable: true, value: { localStorage: { getItem: () => {
      if (!readable) throw new Error("synthetic storage denied after initialization");
      return preference;
    } } } });
    Object.defineProperty(globalThis, "navigator", { configurable: true, value: { doNotTrack: "0", globalPrivacyControl: false } });
    const { client, requests } = fixture({ allowed: browserTelemetryAllowed });
    client.emit({ kind: "count", name: "app_open" }); await tick();
    preference = "false";
    client.emit({ kind: "count", name: "screen_view" }); await tick();
    preference = null; readable = false;
    client.emit({ kind: "count", name: "screen_view" }); await tick();
    readable = true;
    Object.defineProperty(globalThis, "navigator", { configurable: true, value: { get globalPrivacyControl() { throw new Error("synthetic privacy getter failure"); } } });
    client.emit({ kind: "count", name: "screen_view" }); await tick();
    assert.equal(requests.length, 1);
  } finally {
    if (oldWindow) Object.defineProperty(globalThis, "window", oldWindow); else Reflect.deleteProperty(globalThis, "window");
    if (oldNavigator) Object.defineProperty(globalThis, "navigator", oldNavigator); else Reflect.deleteProperty(globalThis, "navigator");
  }
});

test("a throwing asynchronous abort releases the request without retrying", async () => {
  let sent = 0;
  const { client } = fixture({
    controller: () => {
      const controller = new AbortController();
      Object.defineProperty(controller, "abort", { value: () => { throw new Error("synthetic abort failure"); } });
      return controller;
    },
    schedule: callback => setTimeout(callback, 5),
    fetch: () => { sent++; return new Promise<Response>(() => {}); },
  });
  client.emit({ kind: "count", name: "app_open" });
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(sent, 1);
  client.emit({ kind: "count", name: "screen_view" });
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(sent, 2);
});

test("one in-flight request, twenty per minute, two hundred per lifetime and error deduplication", async () => {
  let resolveRequest: (() => void) | undefined;
  let sent = 0;
  const pending = fixture({ fetch: async () => { sent++; await new Promise<void>(resolve => { resolveRequest = resolve; }); return new Response(null, { status: 204 }); } });
  pending.client.emit({ kind: "count", name: "app_open" });
  pending.client.emit({ kind: "count", name: "screen_view" });
  assert.equal(sent, 1);
  resolveRequest?.(); await tick();
  let now = 0;
  const { client, requests } = fixture({ now: () => now });
  for (let index = 0; index < 30; index++) { client.emit({ kind: "count", name: "screen_view" }); await tick(); }
  assert.equal(requests.length, 20);
  now += 60_001;
  client.emit({ kind: "error", name: "request_failed" }); await tick();
  client.emit({ kind: "error", name: "request_failed" }); await tick();
  assert.equal(requests.length, 21);
  for (let minute = 0; minute < 12; minute++) {
    now += 60_001;
    for (let index = 0; index < 20; index++) { client.emit({ kind: "count", name: "screen_view" }); await tick(); }
  }
  assert.equal(requests.length, 200);
});

test("actual web call sites use only fixed screen and recoverable request categories", async () => {
  const source = await readFile(new URL("../src/main.tsx", import.meta.url), "utf8");
  assert.match(source, /telemetry.emit\(\{ kind: "count", name: "screen_view" \}/);
  assert.match(source, /setTaskRowsError\(true\);\s+telemetry.emit\(\{ kind: "error", name: "request_failed" \}/);
});
