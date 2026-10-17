CREATE TABLE social_identities (
  provider TEXT NOT NULL CHECK (provider IN ('microsoft', 'github')),
  identity_hash TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (provider, identity_hash),
  UNIQUE (user_id, provider)
);

CREATE TABLE oauth_flows (
  state_hash TEXT PRIMARY KEY,
  browser_hash TEXT NOT NULL UNIQUE,
  provider TEXT NOT NULL CHECK (provider IN ('microsoft', 'github')),
  intent TEXT NOT NULL CHECK (intent IN ('register', 'login', 'link', 'reauth')),
  client_id TEXT NOT NULL,
  verifier TEXT NOT NULL,
  nonce_hash TEXT NOT NULL,
  payload TEXT NOT NULL,
  user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
  session_hash TEXT REFERENCES sessions(token_hash) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  CHECK (
    (intent IN ('register', 'login') AND user_id IS NULL AND session_hash IS NULL) OR
    (intent IN ('link', 'reauth') AND user_id IS NOT NULL AND session_hash IS NOT NULL)
  )
);
CREATE INDEX oauth_flows_expiry_idx ON oauth_flows(expires_at);
