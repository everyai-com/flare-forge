-- Self-serve members: anyone who signs up owns the Forge repos they
-- create (repo_owners) and drives them end to end; their agent tokens
-- (api_tokens.owner, scopes 'member') resolve to the owner's repos at
-- request time, so a new repo needs no new token.
CREATE TABLE IF NOT EXISTS repo_owners (
  repo TEXT PRIMARY KEY,
  scoped TEXT NOT NULL,
  owner TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_repo_owners_owner ON repo_owners(owner);
ALTER TABLE api_tokens ADD COLUMN owner TEXT;
