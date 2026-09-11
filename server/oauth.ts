import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

/** Providers Fox Focus currently supports through delegated OAuth. */
export type OAuthProvider = "google" | "microsoft";

export type OAuthSecurityErrorCode =
  | "invalid_input"
  | "invalid_callback"
  | "invalid_state"
  | "expired_state"
  | "used_state"
  | "invalid_verifier_envelope"
  | "verifier_decryption_failed"
  | "invalid_token_envelope"
  | "token_decryption_failed";

/**
 * Errors intentionally contain no provider responses, credentials, state, or
 * token material. Route handlers should return a generic error to browsers.
 */
export class OAuthSecurityError extends Error {
  readonly code: OAuthSecurityErrorCode;

  constructor(code: OAuthSecurityErrorCode) {
    super("OAuth security validation failed");
    this.name = "OAuthSecurityError";
    this.code = code;
  }
}

const providers = new Set<OAuthProvider>(["google", "microsoft"]);
const statePattern = /^[A-Za-z0-9_-]{43}$/;
const pkceVerifierPattern = /^[A-Za-z0-9._~-]{43,128}$/;
const printableTokenPattern = /^[\x21-\x7e]+$/;
const visibleTextPattern = /^[\x20-\x7e]+$/;
const parameterNamePattern = /^[A-Za-z][A-Za-z0-9_]*$/;
const tokenTypePattern = /^[A-Za-z][A-Za-z0-9._-]{0,63}$/;
const connectionIdPattern = /^[A-Za-z0-9._:-]{1,200}$/;
const maxAttemptTtlSeconds = 15 * 60;
const defaultAttemptTtlSeconds = 10 * 60;
const maxStoredAttemptLifetimeMs = 24 * 60 * 60 * 1000;
const maxTokenLength = 32 * 1024;
const maxCiphertextBytes = 64 * 1024;
const maxScopes = 32;

function fail(code: OAuthSecurityErrorCode = "invalid_input"): never {
  throw new OAuthSecurityError(code);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function assertProvider(value: unknown): OAuthProvider {
  if (typeof value !== "string" || !providers.has(value as OAuthProvider)) fail();
  return value as OAuthProvider;
}

function assertNonEmptyString(value: unknown, maximum: number): string {
  if (typeof value !== "string" || value.length === 0 || value.length > maximum) fail();
  return value;
}

function assertPrintable(value: unknown, maximum: number): string {
  const text = assertNonEmptyString(value, maximum);
  if (!printableTokenPattern.test(text)) fail();
  return text;
}

function assertCanonicalInstant(value: unknown): string {
  if (typeof value !== "string" || value.length !== 24) fail();
  const date = new Date(value);
  if (Number.isNaN(date.getTime()) || date.toISOString() !== value) fail();
  return value;
}

function assertDate(value: Date): Date {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) fail();
  return value;
}

function assertState(value: unknown): string {
  if (typeof value !== "string" || !statePattern.test(value)) fail("invalid_state");
  return value;
}

function assertCodeVerifier(value: unknown): string {
  if (typeof value !== "string" || !pkceVerifierPattern.test(value)) fail();
  return value;
}

function assertScopes(value: unknown): readonly string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > maxScopes) fail();
  const seen = new Set<string>();
  const scopes = value.map(scope => {
    if (
      typeof scope !== "string" ||
      scope.length === 0 ||
      scope.length > 512 ||
      /\s/.test(scope) ||
      /[\u0000-\u001f\u007f]/.test(scope) ||
      seen.has(scope)
    ) fail();
    seen.add(scope);
    return scope;
  });
  return Object.freeze(scopes);
}

function assertRedirectUri(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 2_048 || value !== value.trim()) fail();
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    fail();
  }
  const localhost = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]" || url.hostname === "::1";
  if ((url.protocol !== "https:" && !(url.protocol === "http:" && localhost)) || url.username || url.password || url.hash) fail();
  return value;
}

function assertAuthorizationEndpoint(value: unknown): URL {
  if (typeof value !== "string" || value.length === 0 || value.length > 2_048 || value !== value.trim()) fail();
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    fail();
  }
  if (url.protocol !== "https:" || url.username || url.password || url.hash) fail();
  for (const name of ["response_type", "client_id", "redirect_uri", "scope", "state", "code_challenge", "code_challenge_method"]) {
    if (url.searchParams.has(name)) fail();
  }
  return url;
}

function assertAdditionalParameters(value: unknown): Readonly<Record<string, string>> {
  if (value === undefined) return Object.freeze({});
  if (!isPlainRecord(value) || Object.keys(value).length > 16) fail();
  const reserved = new Set(["response_type", "client_id", "redirect_uri", "scope", "state", "code_challenge", "code_challenge_method"]);
  const result: Record<string, string> = {};
  for (const [name, parameter] of Object.entries(value)) {
    if (reserved.has(name) || !parameterNamePattern.test(name)) fail();
    const text = assertPrintable(parameter, 1_024);
    result[name] = text;
  }
  return Object.freeze(result);
}

function assertBase64Url(value: unknown, minBytes: number, maxBytes: number): Buffer {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]+$/.test(value)) fail("invalid_token_envelope");
  const decoded = Buffer.from(value, "base64url");
  if (
    decoded.length < minBytes ||
    decoded.length > maxBytes ||
    decoded.toString("base64url") !== value
  ) fail("invalid_token_envelope");
  return decoded;
}

function masterKeyFromBase64Url(value: string): Buffer {
  const key = assertBase64Url(value, 32, 32);
  if (value.length !== 43) fail("invalid_token_envelope");
  return key;
}

/** Returns whether a value is a canonical 32-byte base64url envelope key. */
export function isOAuthTokenMasterKey(value: unknown): value is string {
  try {
    if (typeof value !== "string") return false;
    masterKeyFromBase64Url(value);
    return true;
  } catch {
    return false;
  }
}

function timingSafeStateEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left, "utf8");
  const rightBytes = Buffer.from(right, "utf8");
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

/** State that must be persisted only until the OAuth callback is consumed. */
export type OAuthAttempt = Readonly<{
  state: string;
  provider: OAuthProvider;
  redirectUri: string;
  scopes: readonly string[];
  codeVerifier: string;
  codeChallenge: string;
  createdAt: string;
  expiresAt: string;
  consumedAt: string | null;
}>;

export type CreateOAuthAuthorizationRequestInput = Readonly<{
  provider: OAuthProvider;
  authorizationEndpoint: string;
  clientId: string;
  redirectUri: string;
  scopes: readonly string[];
  /** Provider-specific non-sensitive authorization parameters. */
  additionalParameters?: Readonly<Record<string, string>>;
  ttlSeconds?: number;
  now?: Date;
}>;

export type OAuthAuthorizationRequest = Readonly<{
  authorizationUrl: string;
  attempt: OAuthAttempt;
}>;

/** Derives the RFC 7636 S256 challenge for a verified PKCE verifier. */
export function codeChallengeForVerifier(codeVerifier: string): string {
  const verifier = assertCodeVerifier(codeVerifier);
  return createHash("sha256").update(verifier, "ascii").digest("base64url");
}

/**
 * Hashes an opaque state before it is persisted. State values are 256-bit
 * random values, so a SHA-256 hash is not feasible to reverse or guess.
 */
export function hashOAuthState(state: string): string {
  return createHash("sha256").update(assertState(state), "ascii").digest("base64url");
}

/** A 256-bit nonce for an authorization request that also requests OpenID Connect. */
export function createOAuthNonce(): string {
  return randomBytes(32).toString("base64url");
}

function attemptFromValues(value: OAuthAttempt): OAuthAttempt {
  const state = assertState(value.state);
  const provider = assertProvider(value.provider);
  const redirectUri = assertRedirectUri(value.redirectUri);
  const scopes = assertScopes(value.scopes);
  const codeVerifier = assertCodeVerifier(value.codeVerifier);
  const codeChallenge = codeChallengeForVerifier(codeVerifier);
  if (value.codeChallenge !== codeChallenge) fail();
  const createdAt = assertCanonicalInstant(value.createdAt);
  const expiresAt = assertCanonicalInstant(value.expiresAt);
  const createdAtMs = new Date(createdAt).getTime();
  const expiresAtMs = new Date(expiresAt).getTime();
  if (expiresAtMs <= createdAtMs || expiresAtMs - createdAtMs > maxStoredAttemptLifetimeMs) fail();
  const consumedAt = value.consumedAt === null ? null : assertCanonicalInstant(value.consumedAt);
  if (consumedAt !== null && new Date(consumedAt).getTime() < createdAtMs) fail();
  return Object.freeze({ state, provider, redirectUri, scopes, codeVerifier, codeChallenge, createdAt, expiresAt, consumedAt });
}

/**
 * Makes a short-lived authorization request. Persist `attempt` before sending
 * its URL to a browser, otherwise a callback cannot be safely verified.
 */
export function createOAuthAuthorizationRequest(
  input: CreateOAuthAuthorizationRequestInput,
): OAuthAuthorizationRequest {
  const provider = assertProvider(input.provider);
  const authorizationEndpoint = assertAuthorizationEndpoint(input.authorizationEndpoint);
  const clientId = assertPrintable(input.clientId, 1_024);
  const redirectUri = assertRedirectUri(input.redirectUri);
  const scopes = assertScopes(input.scopes);
  const additionalParameters = assertAdditionalParameters(input.additionalParameters);
  const now = assertDate(input.now ?? new Date());
  const ttlSeconds = input.ttlSeconds ?? defaultAttemptTtlSeconds;
  if (!Number.isSafeInteger(ttlSeconds) || ttlSeconds < 60 || ttlSeconds > maxAttemptTtlSeconds) fail();

  const state = randomBytes(32).toString("base64url");
  const codeVerifier = randomBytes(64).toString("base64url");
  const attempt = attemptFromValues({
    state,
    provider,
    redirectUri,
    scopes,
    codeVerifier,
    codeChallenge: codeChallengeForVerifier(codeVerifier),
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + ttlSeconds * 1_000).toISOString(),
    consumedAt: null,
  });

  authorizationEndpoint.searchParams.set("response_type", "code");
  authorizationEndpoint.searchParams.set("client_id", clientId);
  authorizationEndpoint.searchParams.set("redirect_uri", redirectUri);
  authorizationEndpoint.searchParams.set("scope", scopes.join(" "));
  authorizationEndpoint.searchParams.set("state", state);
  authorizationEndpoint.searchParams.set("code_challenge", attempt.codeChallenge);
  authorizationEndpoint.searchParams.set("code_challenge_method", "S256");
  for (const [name, value] of Object.entries(additionalParameters)) {
    authorizationEndpoint.searchParams.set(name, value);
  }
  return Object.freeze({ authorizationUrl: authorizationEndpoint.toString(), attempt });
}

/**
 * Verifies a callback state and returns the row state after consumption.
 *
 * The caller must persist `consumedAt` with a conditional, one-row update in
 * the same request, such as `WHERE state=? AND consumed_at IS NULL AND
 * expires_at>?`. If that update affects zero rows, reject the callback even
 * if this function returned an attempt.
 */
export function consumeOAuthAttempt(
  attempt: OAuthAttempt,
  callbackState: string,
  now: Date = new Date(),
): OAuthAttempt {
  const verified = attemptFromValues(attempt);
  const receivedState = assertState(callbackState);
  const consumedAt = assertDate(now).toISOString();
  if (!timingSafeStateEqual(verified.state, receivedState)) fail("invalid_state");
  if (verified.consumedAt !== null) fail("used_state");
  if (new Date(verified.expiresAt).getTime() <= now.getTime()) fail("expired_state");
  return attemptFromValues({ ...verified, consumedAt });
}

export type OAuthCallback =
  | Readonly<{ kind: "code"; state: string; code: string }>
  | Readonly<{ kind: "error"; state: string; error: string; errorDescription?: string }>;

function exactlyOne(params: URLSearchParams, name: string): string | undefined {
  const values = params.getAll(name);
  if (values.length > 1) fail("invalid_callback");
  return values[0];
}

/**
 * Parses an OAuth callback without trusting duplicate query parameters. State
 * must still be consumed against the stored attempt before exchanging `code`.
 */
export function parseOAuthCallback(params: URLSearchParams): OAuthCallback {
  const receivedState = exactlyOne(params, "state");
  let state: string;
  try {
    state = assertState(receivedState);
  } catch {
    fail("invalid_callback");
  }
  const code = exactlyOne(params, "code");
  const error = exactlyOne(params, "error");
  const errorDescription = exactlyOne(params, "error_description");
  if ((code === undefined && error === undefined) || (code !== undefined && error !== undefined)) fail("invalid_callback");
  if (code !== undefined) {
    if (!printableTokenPattern.test(code) || code.length > maxTokenLength) fail("invalid_callback");
    return Object.freeze({ kind: "code", state, code });
  }
  if (error === undefined || !/^[A-Za-z0-9._-]{1,128}$/.test(error)) fail("invalid_callback");
  if (errorDescription !== undefined && (!visibleTextPattern.test(errorDescription) || errorDescription.length > 1_024)) {
    fail("invalid_callback");
  }
  return errorDescription === undefined
    ? Object.freeze({ kind: "error", state, error })
    : Object.freeze({ kind: "error", state, error, errorDescription });
}

/**
 * A verifier is encrypted separately from access and refresh tokens because
 * it exists only until the one-time callback is exchanged.
 */
export type OAuthVerifierEnvelopeContext = Readonly<{
  provider: OAuthProvider;
  stateHash: string;
  nonce: string | null;
}>;

function assertVerifierEnvelopeContext(value: OAuthVerifierEnvelopeContext): OAuthVerifierEnvelopeContext {
  const provider = assertProvider(value.provider);
  const stateHash = assertState(value.stateHash);
  const nonce = value.nonce === null ? null : assertState(value.nonce);
  return Object.freeze({ provider, stateHash, nonce });
}

function verifierEnvelopeAad(context: OAuthVerifierEnvelopeContext): Buffer {
  const verified = assertVerifierEnvelopeContext(context);
  return Buffer.from(
    `fox-focus/oauth-verifier/v1\u0000${verified.provider}\u0000${verified.stateHash}\u0000${verified.nonce ?? ""}`,
    "utf8",
  );
}

function parseVerifierEnvelope(value: unknown): OAuthTokenEnvelope {
  try {
    return parseOAuthTokenEnvelope(value);
  } catch {
    fail("invalid_verifier_envelope");
  }
}

/** Seals a PKCE verifier into one SQLite TEXT value, bound to its callback state. */
export function sealOAuthVerifier(
  codeVerifier: string,
  masterKeyBase64Url: string,
  context: OAuthVerifierEnvelopeContext,
): string {
  const verifier = assertCodeVerifier(codeVerifier);
  const plaintext = Buffer.from(JSON.stringify({ version: 1, codeVerifier: verifier }), "utf8");
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", masterKeyFromBase64Url(masterKeyBase64Url), iv);
  cipher.setAAD(verifierEnvelopeAad(context));
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return serializeOAuthTokenEnvelope({
    version: 1,
    algorithm: "AES-256-GCM",
    iv: iv.toString("base64url"),
    ciphertext: ciphertext.toString("base64url"),
    tag: cipher.getAuthTag().toString("base64url"),
  });
}

/** Opens the verifier only after a store has atomically consumed its state hash. */
export function openOAuthVerifier(
  serializedEnvelope: string,
  masterKeyBase64Url: string,
  context: OAuthVerifierEnvelopeContext,
): string {
  const envelope = parseVerifierEnvelope(serializedEnvelope);
  try {
    const decipher = createDecipheriv(
      "aes-256-gcm",
      masterKeyFromBase64Url(masterKeyBase64Url),
      assertBase64Url(envelope.iv, 12, 12),
    );
    decipher.setAAD(verifierEnvelopeAad(context));
    decipher.setAuthTag(assertBase64Url(envelope.tag, 16, 16));
    const plaintext = Buffer.concat([
      decipher.update(assertBase64Url(envelope.ciphertext, 1, maxCiphertextBytes)),
      decipher.final(),
    ]);
    const json = new TextDecoder("utf-8", { fatal: true }).decode(plaintext);
    const parsed: unknown = JSON.parse(json);
    if (!isPlainRecord(parsed) || !hasExactKeys(parsed, ["version", "codeVerifier"]) || parsed.version !== 1) {
      fail("verifier_decryption_failed");
    }
    return assertCodeVerifier(parsed.codeVerifier);
  } catch (error) {
    if (error instanceof OAuthSecurityError && error.code === "verifier_decryption_failed") throw error;
    fail("verifier_decryption_failed");
  }
}

/** The normalized token fields that may be persisted inside an envelope. */
export type OAuthTokenSet = Readonly<{
  accessToken: string;
  refreshToken?: string;
  expiresAt?: string;
  tokenType?: string;
  scopes?: readonly string[];
}>;

function normalizedTokenSet(value: OAuthTokenSet): OAuthTokenSet {
  const allowed = new Set(["accessToken", "refreshToken", "expiresAt", "tokenType", "scopes"]);
  if (!isPlainRecord(value) || Object.keys(value).some(key => !allowed.has(key))) fail();
  const accessToken = assertPrintable(value.accessToken, maxTokenLength);
  const refreshToken = value.refreshToken === undefined ? undefined : assertPrintable(value.refreshToken, maxTokenLength);
  const expiresAt = value.expiresAt === undefined ? undefined : assertCanonicalInstant(value.expiresAt);
  const tokenType = value.tokenType === undefined ? undefined : value.tokenType;
  if (tokenType !== undefined && (typeof tokenType !== "string" || !tokenTypePattern.test(tokenType))) fail();
  const scopes = value.scopes === undefined ? undefined : assertScopes(value.scopes);
  const result: {
    accessToken: string;
    refreshToken?: string;
    expiresAt?: string;
    tokenType?: string;
    scopes?: readonly string[];
  } = { accessToken };
  if (refreshToken !== undefined) result.refreshToken = refreshToken;
  if (expiresAt !== undefined) result.expiresAt = expiresAt;
  if (tokenType !== undefined) result.tokenType = tokenType;
  if (scopes !== undefined) result.scopes = scopes;
  return Object.freeze(result);
}

/** Strictly validates tokens supplied by application code or an opened envelope. */
export function parseOAuthTokenSet(value: unknown): OAuthTokenSet {
  if (!isPlainRecord(value)) fail();
  return normalizedTokenSet(value as OAuthTokenSet);
}

/**
 * Parses the relevant fields of a provider token response. Unknown provider
 * fields are intentionally ignored because Google and Microsoft add metadata.
 */
export function tokenSetFromOAuthResponse(value: unknown, now: Date = new Date()): OAuthTokenSet {
  if (!isPlainRecord(value)) fail();
  const accessToken = assertPrintable(value.access_token, maxTokenLength);
  const refreshToken = value.refresh_token === undefined ? undefined : assertPrintable(value.refresh_token, maxTokenLength);
  const tokenType = value.token_type === undefined ? undefined : value.token_type;
  if (tokenType !== undefined && (typeof tokenType !== "string" || !tokenTypePattern.test(tokenType))) fail();
  const scopeText = value.scope;
  let scopes: readonly string[] | undefined;
  if (scopeText !== undefined) {
    if (typeof scopeText !== "string" || scopeText.trim() !== scopeText || scopeText.length === 0) fail();
    scopes = assertScopes(scopeText.split(" "));
  }
  let expiresAt: string | undefined;
  const expiresIn = value.expires_in;
  if (expiresIn !== undefined) {
    if (typeof expiresIn !== "number" || !Number.isSafeInteger(expiresIn) || expiresIn < 0 || expiresIn > 31_536_000) fail();
    const issuedAt = assertDate(now);
    expiresAt = new Date(issuedAt.getTime() + expiresIn * 1_000).toISOString();
  }
  return normalizedTokenSet({ accessToken, refreshToken, tokenType, scopes, expiresAt });
}

/** Keeps an existing refresh token when a provider intentionally omits it. */
export function mergeOAuthTokenSets(current: OAuthTokenSet, fresh: OAuthTokenSet): OAuthTokenSet {
  const previous = normalizedTokenSet(current);
  const next = normalizedTokenSet(fresh);
  return normalizedTokenSet({
    ...next,
    refreshToken: next.refreshToken ?? previous.refreshToken,
    tokenType: next.tokenType ?? previous.tokenType,
    scopes: next.scopes ?? previous.scopes,
  });
}

export type OAuthTokenEnvelopeContext = Readonly<{
  provider: OAuthProvider;
  connectionId: string;
}>;

export type OAuthTokenEnvelope = Readonly<{
  version: 1;
  algorithm: "AES-256-GCM";
  iv: string;
  ciphertext: string;
  tag: string;
}>;

function assertEnvelopeContext(value: OAuthTokenEnvelopeContext): OAuthTokenEnvelopeContext {
  const provider = assertProvider(value.provider);
  if (typeof value.connectionId !== "string" || !connectionIdPattern.test(value.connectionId)) fail();
  return Object.freeze({ provider, connectionId: value.connectionId });
}

function envelopeAad(context: OAuthTokenEnvelopeContext): Buffer {
  const verified = assertEnvelopeContext(context);
  return Buffer.from(`fox-focus/oauth-token/v1\u0000${verified.provider}\u0000${verified.connectionId}`, "utf8");
}

function normalizedTokenEnvelope(value: OAuthTokenEnvelope): OAuthTokenEnvelope {
  if (!isPlainRecord(value) || !hasExactKeys(value, ["version", "algorithm", "iv", "ciphertext", "tag"])) fail("invalid_token_envelope");
  if (value.version !== 1 || value.algorithm !== "AES-256-GCM") fail("invalid_token_envelope");
  const iv = assertBase64Url(value.iv, 12, 12).toString("base64url");
  const ciphertext = assertBase64Url(value.ciphertext, 1, maxCiphertextBytes).toString("base64url");
  const tag = assertBase64Url(value.tag, 16, 16).toString("base64url");
  return Object.freeze({ version: 1, algorithm: "AES-256-GCM", iv, ciphertext, tag });
}

/** Encrypts a token set for a specific provider connection using AES-256-GCM. */
export function sealOAuthTokenSet(
  tokens: OAuthTokenSet,
  masterKeyBase64Url: string,
  context: OAuthTokenEnvelopeContext,
): OAuthTokenEnvelope {
  const normalized = normalizedTokenSet(tokens);
  const plaintext = Buffer.from(JSON.stringify(normalized), "utf8");
  if (plaintext.length === 0 || plaintext.length > maxCiphertextBytes) fail();
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", masterKeyFromBase64Url(masterKeyBase64Url), iv);
  cipher.setAAD(envelopeAad(context));
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return normalizedTokenEnvelope({
    version: 1,
    algorithm: "AES-256-GCM",
    iv: iv.toString("base64url"),
    ciphertext: ciphertext.toString("base64url"),
    tag: cipher.getAuthTag().toString("base64url"),
  });
}

/** Serializes a validated envelope to one SQLite TEXT value. */
export function serializeOAuthTokenEnvelope(envelope: OAuthTokenEnvelope): string {
  const verified = normalizedTokenEnvelope(envelope);
  return JSON.stringify(verified);
}

/** Strictly parses an envelope previously read from a SQLite TEXT column. */
export function parseOAuthTokenEnvelope(value: unknown): OAuthTokenEnvelope {
  if (typeof value !== "string" || value.length === 0 || value.length > 131_072) fail("invalid_token_envelope");
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    fail("invalid_token_envelope");
  }
  return normalizedTokenEnvelope(parsed as OAuthTokenEnvelope);
}

/** Opens and strictly validates a token envelope for its original connection. */
export function openOAuthTokenSet(
  serializedEnvelope: string,
  masterKeyBase64Url: string,
  context: OAuthTokenEnvelopeContext,
): OAuthTokenSet {
  const envelope = parseOAuthTokenEnvelope(serializedEnvelope);
  try {
    const decipher = createDecipheriv(
      "aes-256-gcm",
      masterKeyFromBase64Url(masterKeyBase64Url),
      assertBase64Url(envelope.iv, 12, 12),
    );
    decipher.setAAD(envelopeAad(context));
    decipher.setAuthTag(assertBase64Url(envelope.tag, 16, 16));
    const plaintext = Buffer.concat([
      decipher.update(assertBase64Url(envelope.ciphertext, 1, maxCiphertextBytes)),
      decipher.final(),
    ]);
    const json = new TextDecoder("utf-8", { fatal: true }).decode(plaintext);
    let parsed: unknown;
    try {
      parsed = JSON.parse(json);
    } catch {
      fail("token_decryption_failed");
    }
    return parseOAuthTokenSet(parsed);
  } catch (error) {
    if (error instanceof OAuthSecurityError) throw error;
    fail("token_decryption_failed");
  }
}
