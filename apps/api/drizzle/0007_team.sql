-- Team members with roles. Users that existed before roles were introduced owned their workspace.
ALTER TABLE merchant_users ADD COLUMN role varchar(16) NOT NULL DEFAULT 'viewer'
  CHECK (role IN ('owner', 'admin', 'developer', 'viewer'));
UPDATE merchant_users SET role = 'owner';
ALTER TABLE merchant_users ADD COLUMN name varchar(120);
ALTER TABLE merchant_users ADD COLUMN last_login_at timestamptz;
ALTER TABLE merchant_users ADD COLUMN password_changed_at timestamptz;

-- Where and from what a session was opened, so members can recognise and end their sessions.
ALTER TABLE dashboard_sessions ADD COLUMN ip inet;
ALTER TABLE dashboard_sessions ADD COLUMN user_agent varchar(512);
ALTER TABLE dashboard_sessions ADD COLUMN last_seen_at timestamptz;
UPDATE dashboard_sessions SET last_seen_at = created_at;
ALTER TABLE dashboard_sessions ALTER COLUMN last_seen_at SET DEFAULT now();
ALTER TABLE dashboard_sessions ALTER COLUMN last_seen_at SET NOT NULL;

-- Invitation links. Only the SHA-256 of the token is stored; the link is shown once to the inviter.
CREATE TABLE merchant_invitations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  merchant_id uuid NOT NULL REFERENCES merchants(id),
  email varchar(320) NOT NULL,
  role varchar(16) NOT NULL CHECK (role IN ('owner', 'admin', 'developer', 'viewer')),
  token_hash varchar(64) NOT NULL UNIQUE,
  invited_by uuid REFERENCES merchant_users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  accepted_at timestamptz,
  accepted_user_id uuid REFERENCES merchant_users(id),
  revoked_at timestamptz,
  CONSTRAINT merchant_invitations_state_check CHECK (accepted_at IS NULL OR revoked_at IS NULL)
);
CREATE INDEX merchant_invitations_merchant_idx ON merchant_invitations (merchant_id, created_at DESC);
CREATE UNIQUE INDEX merchant_invitations_pending_unique ON merchant_invitations (merchant_id, lower(email))
  WHERE accepted_at IS NULL AND revoked_at IS NULL;
