CREATE TABLE merchant_users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  merchant_id uuid NOT NULL REFERENCES merchants(id),
  email varchar(320) NOT NULL,
  password_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  disabled_at timestamptz
);
CREATE UNIQUE INDEX merchant_users_email_unique ON merchant_users (lower(email));

CREATE TABLE dashboard_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES merchant_users(id) ON DELETE CASCADE,
  token_hash varchar(64) NOT NULL UNIQUE,
  csrf_hash varchar(64) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz
);
CREATE INDEX dashboard_sessions_expiry_idx ON dashboard_sessions (expires_at) WHERE revoked_at IS NULL;
