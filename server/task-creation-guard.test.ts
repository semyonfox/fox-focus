import assert from "node:assert/strict";
import { test } from "node:test";
import { hasCreationAttempt, heldCreationInput, holdCreationAttempt, sourceCreationNonce } from "../src/task-creation-guard.ts";
import type { TaskCreateInput } from "../src/row-model.ts";

test("lost acknowledgement and modal reopen retain the original nonce and immutable input", () => {
  const nonce = sourceCreationNonce("brief", "2026-10-04", 2);
  const input: TaskCreateInput = {
    nonce, destination: { accountId: "fixture-account", listId: "fixture-list" },
    title: "Sample chapter", notes: "Synthetic notes", doOn: null,
    plan: { priority: "medium", waiting: false, deadlineOn: null, plannedOn: null, plannedAt: null, estimateMinutes: null },
  };
  assert.equal(holdCreationAttempt(input), true);
  input.title = "Changed after a lost response";
  input.destination.listId = "another-list";
  assert.equal(heldCreationInput(nonce)?.title, "Sample chapter");
  assert.equal(heldCreationInput(nonce)?.destination.listId, "fixture-list");
  assert.equal(hasCreationAttempt(sourceCreationNonce("brief", "2026-10-04", 2)), true);
  assert.equal(holdCreationAttempt({ ...input, nonce: sourceCreationNonce("brief", "2026-10-04", 2) }), false);
  assert.match(nonce, /^[A-Za-z0-9_-]{1,200}$/);
  assert.notEqual(nonce, sourceCreationNonce("brief", "2026-10-04", 3));
});
