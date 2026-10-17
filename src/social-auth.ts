import { socialAuthorizationSchema } from '../shared/api-schemas';
import type { SocialAuthInput, SocialProviderId } from '../shared/contracts';
import { request } from './api';

export async function beginSocialSignIn(provider: SocialProviderId, body: SocialAuthInput, csrfToken?: string | null): Promise<void> {
  const result = await request(`/auth/social/${provider}/start`, socialAuthorizationSchema, {
    method: 'POST', body, csrfToken,
  });
  if (result.provider !== provider) throw new Error('The sign-in provider did not match the requested method.');
  window.location.assign(result.authorizationUrl);
}

const failures: Record<string, string> = {
  expired: 'The sign-in request expired or was already used. Start again.',
  cancelled: 'Account sign-in was cancelled. No new sign-in method was added.',
  unavailable: 'Account sign-in is temporarily unavailable. Try again shortly or use another method.',
  'invalid-identity': 'The account sign-in could not be verified. Start again with the intended provider.',
  'not-registered': 'This provider account is not registered here. Register a learner account, or sign in with an existing method to link it in My account.',
  'already-registered': 'This provider account is already registered. Use Sign in instead.',
  'already-linked': 'This provider or provider account is already linked. Review your sign-in methods in My account.',
  'wrong-account': 'Use the provider account already linked to this learner account.',
  'session-ended': 'The original sign-in session ended or is no longer recent. Sign in again before linking an account.',
  'handle-taken': 'That public handle was just registered. Choose another handle and start again.',
  'consent-changed': 'The participation policies changed during registration. Review the current versions and start again.',
};

export function socialSignInFailure(search: string): string {
  const reason = new URLSearchParams(search).get('authError');
  return reason ? failures[reason] || 'Account sign-in could not be completed. Start again.' : '';
}
