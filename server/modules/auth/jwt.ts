/**
 * JWT helpers for the first-party auth system.
 *
 * Two token kinds share one secret (JWT_SECRET):
 *  - access tokens (short-lived, sent as `Authorization: Bearer ...`)
 *  - refresh tokens (long-lived, only sent to /api/auth/refresh)
 * The `typ` claim distinguishes them, so a refresh token can never be used to
 * call business APIs and an access token can never mint new tokens.
 */
import jwt from 'jsonwebtoken';

export interface AccessPayload {
  sub: string;
  username: string;
  typ: 'access';
  ver?: number;
}

export interface RefreshPayload {
  sub: string;
  username: string;
  typ: 'refresh';
  ver?: number;
}

function getSecret(): string {
  const secret = process.env.JWT_SECRET;
  if (!secret || secret.length < 16) {
    throw new Error(
      'JWT_SECRET is missing or too short (min 16 chars). Set it in the environment before starting the app.',
    );
  }
  return secret;
}

/** Sign a short-lived access token (default 2h). */
export function signAccessToken(user: {
  id: string;
  username: string;
  sessionVersion?: number;
}): string {
  return jwt.sign(
    { sub: user.id, username: user.username, typ: 'access', ver: user.sessionVersion ?? 0 },
    getSecret(),
    {
      expiresIn: (process.env.ACCESS_TOKEN_TTL ?? '2h') as jwt.SignOptions['expiresIn'],
    },
  );
}

/** Sign a long-lived refresh token (default 30d). */
export function signRefreshToken(user: {
  id: string;
  username: string;
  sessionVersion?: number;
}): string {
  return jwt.sign(
    { sub: user.id, username: user.username, typ: 'refresh', ver: user.sessionVersion ?? 0 },
    getSecret(),
    {
      expiresIn: (process.env.REFRESH_TOKEN_TTL ?? '30d') as jwt.SignOptions['expiresIn'],
    },
  );
}

/** Verify an access token; returns null when invalid/expired/mismatched kind. */
export function verifyAccessToken(token: string): AccessPayload | null {
  try {
    const payload = jwt.verify(token, getSecret());
    if (typeof payload === 'string' || payload.typ !== 'access') return null;
    return payload as AccessPayload;
  } catch {
    return null;
  }
}

/** Verify a refresh token; returns null when invalid/expired/mismatched kind. */
export function verifyRefreshToken(token: string): RefreshPayload | null {
  try {
    const payload = jwt.verify(token, getSecret());
    if (typeof payload === 'string' || payload.typ !== 'refresh') return null;
    return payload as RefreshPayload;
  } catch {
    return null;
  }
}
