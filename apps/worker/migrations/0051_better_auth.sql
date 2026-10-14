-- Better Auth (better-auth.com) owns account creation and the
-- email+password / magic-link sign-in surface under /v1/auth/*, on this
-- same D1. Its four core tables carry an auth_ prefix so they sit next
-- to Flare's own users/sessions without colliding. Column names are
-- Better Auth's defaults (camelCase); SQLite stores its dates as ISO
-- text and booleans as 0/1. A Flare session (flare_session cookie,
-- admin bit) is minted by POST /v1/admin/auth/bridge once Better Auth
-- vouches for an email; nothing else reads these tables.
CREATE TABLE IF NOT EXISTS auth_user (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  emailVerified INTEGER NOT NULL DEFAULT 0,
  image TEXT,
  createdAt TEXT NOT NULL,
  updatedAt TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS auth_session (
  id TEXT PRIMARY KEY,
  expiresAt TEXT NOT NULL,
  token TEXT NOT NULL UNIQUE,
  createdAt TEXT NOT NULL,
  updatedAt TEXT NOT NULL,
  ipAddress TEXT,
  userAgent TEXT,
  userId TEXT NOT NULL REFERENCES auth_user(id)
);
CREATE INDEX IF NOT EXISTS idx_auth_session_user ON auth_session(userId);
CREATE TABLE IF NOT EXISTS auth_account (
  id TEXT PRIMARY KEY,
  accountId TEXT NOT NULL,
  providerId TEXT NOT NULL,
  userId TEXT NOT NULL REFERENCES auth_user(id),
  accessToken TEXT,
  refreshToken TEXT,
  idToken TEXT,
  accessTokenExpiresAt TEXT,
  refreshTokenExpiresAt TEXT,
  scope TEXT,
  password TEXT,
  createdAt TEXT NOT NULL,
  updatedAt TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_auth_account_user ON auth_account(userId);
CREATE TABLE IF NOT EXISTS auth_verification (
  id TEXT PRIMARY KEY,
  identifier TEXT NOT NULL,
  value TEXT NOT NULL,
  expiresAt TEXT NOT NULL,
  createdAt TEXT NOT NULL,
  updatedAt TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_auth_verification_identifier ON auth_verification(identifier);
