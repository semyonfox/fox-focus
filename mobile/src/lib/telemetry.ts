import { createTelemetry } from "@shared/telemetry";

// native collection stays off until owner configuration and native privacy controls exist
export const telemetry = createTelemetry({ surface: "android" }, { allowed: () => false });
