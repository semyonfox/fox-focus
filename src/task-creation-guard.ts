import type { TaskCreateInput } from "./row-model.ts";

const attempted = new Map<string, TaskCreateInput>();

export function hasCreationAttempt(nonce: string): boolean {
  return attempted.has(nonce);
}

export function heldCreationInput(nonce: string): TaskCreateInput | undefined {
  return attempted.get(nonce);
}

export function holdCreationAttempt(input: TaskCreateInput): boolean {
  if (attempted.has(input.nonce)) return false;
  attempted.set(input.nonce, {
    ...input, destination: { ...input.destination }, plan: { ...input.plan },
    ...(input.inbox ? { inbox: { ...input.inbox } } : {}),
    ...(input.reminder ? { reminder: { ...input.reminder } } : {}),
  });
  return true;
}

export function sourceCreationNonce(kind: "brief" | "inbox", sourceId: string, position = 0): string {
  return `${kind}-${sourceId.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 150)}-${position}`;
}
