import { HTTPException } from 'hono/http-exception';
import { requireSession, sha256 } from './security';
import type { AppContext, SessionRow } from './types';

export const MANAGEMENT_GITHUB_USER_ID = '8750972';
let ownerHash: Promise<string> | undefined;

export async function canManageSite(c: AppContext, session: SessionRow | null = c.get('session')): Promise<boolean> {
  if (!session) return false;
  ownerHash ??= sha256(JSON.stringify(['github', 'https://github.com', MANAGEMENT_GITHUB_USER_ID]));
  const identity = await c.env.DB.prepare(
    'SELECT user_id FROM social_identities WHERE user_id = ? AND provider = ? AND identity_hash = ?',
  ).bind(session.user_id, 'github', await ownerHash).first<{ user_id: string }>();
  return identity?.user_id === session.user_id;
}

export async function requireSiteManagement(c: AppContext, fresh = true): Promise<SessionRow> {
  const session = requireSession(c, { fresh, currentConsent: true });
  if (!await canManageSite(c, session)) throw new HTTPException(403, { message: 'Site management access is not available to this account.' });
  return session;
}

export async function requireReviewAccess(c: AppContext): Promise<SessionRow> {
  const session = requireSession(c, { fresh: true, currentConsent: true });
  if (session.role !== 'moderator' && !await canManageSite(c, session)) {
    throw new HTTPException(403, { message: 'Moderator access is required.' });
  }
  return session;
}
