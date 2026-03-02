import { createHmac, randomBytes, timingSafeEqual } from 'crypto';

export interface DelegationTokenPayload {
  v: 1;
  iss: string; // issuer agent id
  sub: string; // delegatee/target agent id
  scopes: string[];
  iat: number; // seconds
  exp: number; // seconds
  jti: string;
  sessionId?: string;
  threadKey?: string;
  studioId?: string;
}

export interface MintDelegationTokenInput {
  issuerAgentId: string;
  delegateeAgentId: string;
  scopes: string[];
  ttlSeconds?: number;
  sessionId?: string;
  threadKey?: string;
  studioId?: string;
  nowSeconds?: number;
}

export interface VerifyDelegationTokenOptions {
  nowSeconds?: number;
  expectedIssuerAgentId?: string;
  expectedDelegateeAgentId?: string;
  expectedThreadKey?: string;
  requiredScopes?: string[];
}

export interface VerifyDelegationTokenResult {
  valid: boolean;
  payload?: DelegationTokenPayload;
  error?: string;
}

const TOKEN_TYPE = 'PCP-DELEGATION';
const DEFAULT_TTL_SECONDS = 15 * 60;
const MAX_TTL_SECONDS = 24 * 60 * 60;

function base64urlEncode(input: Buffer | string): string {
  return Buffer.from(input)
    .toString('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}

function base64urlDecode(input: string): Buffer {
  const normalized = input.replace(/-/g, '+').replace(/_/g, '/');
  const padding = normalized.length % 4 === 0 ? '' : '='.repeat(4 - (normalized.length % 4));
  return Buffer.from(normalized + padding, 'base64');
}

function sign(data: string, secret: string): string {
  return base64urlEncode(createHmac('sha256', secret).update(data).digest());
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

function normalizeScopes(scopes: string[]): string[] {
  return Array.from(
    new Set(
      scopes
        .map((scope) => scope.trim().toLowerCase())
        .filter(Boolean)
    )
  ).sort((a, b) => a.localeCompare(b));
}

export function mintDelegationToken(input: MintDelegationTokenInput, secret: string): string {
  const issuerAgentId = input.issuerAgentId.trim().toLowerCase();
  const delegateeAgentId = input.delegateeAgentId.trim().toLowerCase();
  if (!issuerAgentId || !delegateeAgentId) {
    throw new Error('issuerAgentId and delegateeAgentId are required');
  }

  const scopes = normalizeScopes(input.scopes || []);
  if (scopes.length === 0) {
    throw new Error('At least one scope is required');
  }

  const now = input.nowSeconds ?? Math.floor(Date.now() / 1000);
  const ttl = Math.max(1, Math.min(input.ttlSeconds ?? DEFAULT_TTL_SECONDS, MAX_TTL_SECONDS));

  const header = {
    typ: TOKEN_TYPE,
    alg: 'HS256',
  };

  const payload: DelegationTokenPayload = {
    v: 1,
    iss: issuerAgentId,
    sub: delegateeAgentId,
    scopes,
    iat: now,
    exp: now + ttl,
    jti: randomBytes(8).toString('hex'),
    ...(input.sessionId ? { sessionId: input.sessionId } : {}),
    ...(input.threadKey ? { threadKey: input.threadKey } : {}),
    ...(input.studioId ? { studioId: input.studioId } : {}),
  };

  const headerPart = base64urlEncode(JSON.stringify(header));
  const payloadPart = base64urlEncode(JSON.stringify(payload));
  const data = `${headerPart}.${payloadPart}`;
  const signature = sign(data, secret);
  return `${data}.${signature}`;
}

export function decodeDelegationToken(token: string): DelegationTokenPayload {
  const parts = token.split('.');
  if (parts.length !== 3) {
    throw new Error('Malformed token');
  }

  const header = JSON.parse(base64urlDecode(parts[0]!).toString('utf8')) as {
    typ?: string;
    alg?: string;
  };
  if (header.typ !== TOKEN_TYPE || header.alg !== 'HS256') {
    throw new Error('Unsupported token header');
  }

  return JSON.parse(base64urlDecode(parts[1]!).toString('utf8')) as DelegationTokenPayload;
}

export function verifyDelegationToken(
  token: string,
  secret: string,
  options: VerifyDelegationTokenOptions = {}
): VerifyDelegationTokenResult {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) {
      return { valid: false, error: 'Malformed token' };
    }

    const data = `${parts[0]}.${parts[1]}`;
    const expectedSig = sign(data, secret);
    if (!safeEqual(expectedSig, parts[2]!)) {
      return { valid: false, error: 'Invalid signature' };
    }

    const payload = decodeDelegationToken(token);
    const now = options.nowSeconds ?? Math.floor(Date.now() / 1000);

    if (payload.exp <= now) {
      return { valid: false, error: 'Token expired' };
    }

    if (payload.iat > now + 60) {
      return { valid: false, error: 'Token issued in the future' };
    }

    if (options.expectedIssuerAgentId && payload.iss !== options.expectedIssuerAgentId.toLowerCase()) {
      return { valid: false, error: 'Unexpected issuer' };
    }

    if (options.expectedDelegateeAgentId && payload.sub !== options.expectedDelegateeAgentId.toLowerCase()) {
      return { valid: false, error: 'Unexpected delegatee' };
    }

    if (options.expectedThreadKey && payload.threadKey !== options.expectedThreadKey) {
      return { valid: false, error: 'Thread mismatch' };
    }

    if (options.requiredScopes && options.requiredScopes.length > 0) {
      const required = normalizeScopes(options.requiredScopes);
      const scopeSet = new Set(payload.scopes.map((scope) => scope.toLowerCase()));
      const missing = required.filter((scope) => !scopeSet.has(scope));
      if (missing.length > 0) {
        return { valid: false, error: `Missing scope(s): ${missing.join(', ')}` };
      }
    }

    return { valid: true, payload };
  } catch (error) {
    return { valid: false, error: `Invalid token: ${String(error)}` };
  }
}
