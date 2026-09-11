import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import {
  OAuthSecurityError,
  createOAuthNonce,
  consumeOAuthAttempt,
  createOAuthAuthorizationRequest,
  hashOAuthState,
  mergeOAuthTokenSets,
  openOAuthVerifier,
  openOAuthTokenSet,
  parseOAuthCallback,
  parseOAuthTokenEnvelope,
  sealOAuthTokenSet,
  sealOAuthVerifier,
  serializeOAuthTokenEnvelope,
  tokenSetFromOAuthResponse,
} from "./oauth.ts";

const issuedAt = new Date("2026-09-11T09:00:00.000Z");
const masterKey = Buffer.alloc(32, 7).toString("base64url");

function expectSecurityError(code: OAuthSecurityError["code"]) {
  return (error: unknown): boolean => error instanceof OAuthSecurityError && error.code === code;
}

function newRequest() {
  return createOAuthAuthorizationRequest({
    provider: "google",
    authorizationEndpoint: "https://accounts.google.com/o/oauth2/v2/auth",
    clientId: "test-client.apps.googleusercontent.com",
    redirectUri: "https://focus.example.test/api/oauth/google/callback",
    scopes: [
      "https://www.googleapis.com/auth/calendar.events.readonly",
      "https://www.googleapis.com/auth/tasks.readonly",
    ],
    additionalParameters: { access_type: "offline", include_granted_scopes: "true" },
    now: issuedAt,
  });
}

test("creates a Google-compatible authorization URL with state and PKCE S256", () => {
  const request = newRequest();
  const url = new URL(request.authorizationUrl);

  assert.equal(request.attempt.createdAt, "2026-09-11T09:00:00.000Z");
  assert.equal(request.attempt.expiresAt, "2026-09-11T09:10:00.000Z");
  assert.match(request.attempt.state, /^[A-Za-z0-9_-]{43}$/);
  assert.match(request.attempt.codeVerifier, /^[A-Za-z0-9._~-]{43,128}$/);
  assert.equal(
    request.attempt.codeChallenge,
    createHash("sha256").update(request.attempt.codeVerifier, "ascii").digest("base64url"),
  );
  assert.equal(url.searchParams.get("response_type"), "code");
  assert.equal(url.searchParams.get("client_id"), "test-client.apps.googleusercontent.com");
  assert.equal(url.searchParams.get("redirect_uri"), "https://focus.example.test/api/oauth/google/callback");
  assert.equal(url.searchParams.get("state"), request.attempt.state);
  assert.equal(url.searchParams.get("code_challenge"), request.attempt.codeChallenge);
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");
  assert.equal(url.searchParams.get("access_type"), "offline");
  assert.equal(url.searchParams.get("include_granted_scopes"), "true");

});

test("consumes state exactly once and rejects expired or mismatched callbacks", () => {
  const request = newRequest();
  const consumed = consumeOAuthAttempt(
    request.attempt,
    request.attempt.state,
    new Date("2026-09-11T09:01:00.000Z"),
  );
  assert.equal(consumed.consumedAt, "2026-09-11T09:01:00.000Z");
  assert.throws(
    () => consumeOAuthAttempt(consumed, consumed.state, new Date("2026-09-11T09:02:00.000Z")),
    expectSecurityError("used_state"),
  );
  assert.throws(
    () => consumeOAuthAttempt(request.attempt, "x".repeat(43), new Date("2026-09-11T09:01:00.000Z")),
    expectSecurityError("invalid_state"),
  );
  assert.throws(
    () => consumeOAuthAttempt(request.attempt, request.attempt.state, new Date("2026-09-11T09:10:00.000Z")),
    expectSecurityError("expired_state"),
  );
});

test("hashes state and encrypts a PKCE verifier for the one-time attempt row", () => {
  const request = newRequest();
  const stateHash = hashOAuthState(request.attempt.state);
  const nonce = createOAuthNonce();
  const context = { provider: request.attempt.provider, stateHash, nonce };
  const verifierEnvelope = sealOAuthVerifier(request.attempt.codeVerifier, masterKey, context);

  assert.match(stateHash, /^[A-Za-z0-9_-]{43}$/);
  assert.notEqual(stateHash, request.attempt.state);
  assert.match(nonce, /^[A-Za-z0-9_-]{43}$/);
  assert.ok(!verifierEnvelope.includes(request.attempt.codeVerifier));
  assert.equal(openOAuthVerifier(verifierEnvelope, masterKey, context), request.attempt.codeVerifier);
  assert.throws(
    () => openOAuthVerifier(verifierEnvelope, masterKey, { ...context, nonce: null }),
    expectSecurityError("verifier_decryption_failed"),
  );
});

test("strictly parses callbacks and rejects ambiguous parameters", () => {
  const success = parseOAuthCallback(new URLSearchParams({
    state: "a".repeat(43),
    code: "authorization-code-123",
  }));
  assert.deepEqual(success, { kind: "code", state: "a".repeat(43), code: "authorization-code-123" });

  const providerError = parseOAuthCallback(new URLSearchParams({
    state: "b".repeat(43),
    error: "access_denied",
    error_description: "The user denied access",
  }));
  assert.deepEqual(providerError, {
    kind: "error",
    state: "b".repeat(43),
    error: "access_denied",
    errorDescription: "The user denied access",
  });

  const duplicate = new URLSearchParams();
  duplicate.append("state", "c".repeat(43));
  duplicate.append("state", "d".repeat(43));
  duplicate.append("code", "one");
  assert.throws(() => parseOAuthCallback(duplicate), expectSecurityError("invalid_callback"));
});

test("encrypts a token set into a context-bound SQLite envelope", () => {
  const tokens = {
    accessToken: "access-token-for-test-only",
    refreshToken: "refresh-token-for-test-only",
    expiresAt: "2026-09-11T10:00:00.000Z",
    tokenType: "Bearer",
    scopes: ["Calendars.ReadBasic", "Tasks.Read"],
  } as const;
  const context = { provider: "microsoft" as const, connectionId: "connection-123" };
  const envelope = sealOAuthTokenSet(tokens, masterKey, context);
  const serialized = serializeOAuthTokenEnvelope(envelope);

  assert.ok(!serialized.includes(tokens.accessToken));
  assert.ok(!serialized.includes(tokens.refreshToken));
  assert.deepEqual(openOAuthTokenSet(serialized, masterKey, context), tokens);
  assert.throws(
    () => openOAuthTokenSet(serialized, masterKey, { ...context, connectionId: "connection-456" }),
    expectSecurityError("token_decryption_failed"),
  );

  const changedTag = `${envelope.tag[0] === "A" ? "B" : "A"}${envelope.tag.slice(1)}`;
  const tampered = serializeOAuthTokenEnvelope({ ...envelope, tag: changedTag });
  assert.throws(() => openOAuthTokenSet(tampered, masterKey, context), expectSecurityError("token_decryption_failed"));
  assert.throws(() => parseOAuthTokenEnvelope("not json"), expectSecurityError("invalid_token_envelope"));
  assert.throws(
    () => sealOAuthTokenSet(tokens, "too-short", context),
    expectSecurityError("invalid_token_envelope"),
  );
});

test("normalizes token responses and preserves a previously issued refresh token", () => {
  const fresh = tokenSetFromOAuthResponse({
    access_token: "new-access-token",
    expires_in: 3_600,
    scope: "Calendars.ReadBasic Tasks.Read",
    token_type: "Bearer",
    provider_metadata: "ignored",
  }, issuedAt);
  assert.deepEqual(fresh, {
    accessToken: "new-access-token",
    expiresAt: "2026-09-11T10:00:00.000Z",
    scopes: ["Calendars.ReadBasic", "Tasks.Read"],
    tokenType: "Bearer",
  });
  assert.deepEqual(mergeOAuthTokenSets({ accessToken: "old", refreshToken: "long-lived-refresh" }, fresh), {
    ...fresh,
    refreshToken: "long-lived-refresh",
  });
});
