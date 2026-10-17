import type { Context } from 'hono';

export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  ENVIRONMENT: 'local' | 'production';
  APP_ORIGIN: string;
  RP_ID: string;
  LEGAL_APPROVED: string;
  OPERATOR_NAME: string;
  CONTACT_URL: string;
  TURNSTILE_SITE_KEY: string;
  TURNSTILE_SECRET_KEY?: string;
  RATE_LIMIT_SALT?: string;
  MICROSOFT_CLIENT_ID?: string;
  MICROSOFT_CLIENT_SECRET?: string;
  GITHUB_CLIENT_ID?: string;
  GITHUB_CLIENT_SECRET?: string;
}

export type SiteEnv = Omit<Env, 'DB' | 'ASSETS'>;

export interface SessionRow {
  token_hash: string;
  user_id: string;
  handle: string;
  role: 'learner' | 'moderator';
  csrf_token: string;
  authenticated_at: number;
  expires_at: number;
  terms_version: string;
  privacy_version: string;
}

export type AppEnv = {
  Bindings: Env;
  Variables: {
    session: SessionRow | null;
    requestId: string;
  };
};

export type AppContext = Context<AppEnv>;
