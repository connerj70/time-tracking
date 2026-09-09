-- Tallied schema. Applied idempotently by src/db/migrate.ts into the schema named by DATABASE_SCHEMA.
-- No extensions required: gen_random_uuid() is built into Postgres 13+, emails are stored lowercase.

CREATE TABLE IF NOT EXISTS users (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email         text NOT NULL,
  name          text,
  avatar_url    text,
  auth_provider text NOT NULL DEFAULT 'magic_link',   -- google | magic_link
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS users_email_lower_idx ON users (lower(email));

CREATE TABLE IF NOT EXISTS workspaces (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name                      text NOT NULL,
  currency                  text NOT NULL DEFAULT 'USD',
  timezone                  text NOT NULL DEFAULT 'UTC',
  default_rate_cents        integer NOT NULL DEFAULT 0,
  invoice_prefix            text NOT NULL DEFAULT 'INV-',
  next_invoice_number       integer NOT NULL DEFAULT 1,
  logo_url                  text,
  plan                      text NOT NULL DEFAULT 'free',         -- free | pro | team
  stripe_customer_id        text,
  stripe_subscription_id    text,
  stripe_connect_account_id text,
  business_address          text,
  created_at                timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS memberships (
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  role         text NOT NULL DEFAULT 'owner',                      -- owner | member
  created_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, workspace_id)
);

CREATE TABLE IF NOT EXISTS clients (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id       uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name               text NOT NULL,
  billing_email      text,
  address            text,
  default_rate_cents integer,
  net_terms_days     integer NOT NULL DEFAULT 30,
  archived           boolean NOT NULL DEFAULT false,
  created_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, name)
);
CREATE INDEX IF NOT EXISTS clients_workspace_idx ON clients(workspace_id);

CREATE TABLE IF NOT EXISTS projects (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id     uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  client_id        uuid REFERENCES clients(id) ON DELETE SET NULL,
  name             text NOT NULL,
  aliases          text[] NOT NULL DEFAULT '{}',
  rate_cents       integer,
  billable_default boolean NOT NULL DEFAULT true,
  archived         boolean NOT NULL DEFAULT false,
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, name)
);
CREATE INDEX IF NOT EXISTS projects_workspace_idx ON projects(workspace_id);

CREATE TABLE IF NOT EXISTS invoices (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id            uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  client_id               uuid NOT NULL REFERENCES clients(id),
  number                  text NOT NULL,
  status                  text NOT NULL DEFAULT 'draft',           -- draft | sent | viewed | paid | void
  issue_date              date NOT NULL,
  due_date                date NOT NULL,
  currency                text NOT NULL,
  subtotal_cents          bigint NOT NULL DEFAULT 0,
  tax_rate_bps            integer NOT NULL DEFAULT 0,
  tax_cents               bigint NOT NULL DEFAULT 0,
  total_cents             bigint NOT NULL DEFAULT 0,
  notes                   text,
  public_token            text UNIQUE NOT NULL,
  stripe_payment_link_url text,
  stripe_payment_link_id  text,
  sent_at                 timestamptz,
  viewed_at               timestamptz,
  paid_at                 timestamptz,
  paid_via                text,                                     -- stripe | manual
  paid_note               text,
  created_at              timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, number)
);
CREATE INDEX IF NOT EXISTS invoices_workspace_idx ON invoices(workspace_id, status);

CREATE TABLE IF NOT EXISTS invoice_lines (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_id     uuid NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  position       integer NOT NULL DEFAULT 0,
  description    text NOT NULL,
  hours          numeric(8,2) NOT NULL,
  rate_cents     integer NOT NULL,
  amount_cents   bigint NOT NULL,
  time_entry_ids uuid[] NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS time_entries (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id    uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id         uuid NOT NULL REFERENCES users(id),
  project_id      uuid REFERENCES projects(id),
  description     text NOT NULL DEFAULT '',
  date            date NOT NULL,                                    -- workspace-local day
  started_at      timestamptz,                                      -- UTC
  ended_at        timestamptz,                                      -- UTC
  duration_min    integer NOT NULL CHECK (duration_min > 0),
  billable        boolean NOT NULL DEFAULT true,
  rate_cents      integer,                                          -- per-entry override
  tags            text[] NOT NULL DEFAULT '{}',
  invoice_id      uuid REFERENCES invoices(id) ON DELETE SET NULL,
  source          text NOT NULL DEFAULT 'chat',                     -- chat | proposal | import | timer
  source_ref      jsonb,
  idempotency_key text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, idempotency_key)
);
CREATE INDEX IF NOT EXISTS time_entries_ws_date_idx ON time_entries(workspace_id, date);
CREATE INDEX IF NOT EXISTS time_entries_project_idx ON time_entries(project_id);
CREATE INDEX IF NOT EXISTS time_entries_invoice_idx ON time_entries(invoice_id);

CREATE TABLE IF NOT EXISTS imports (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  source       text NOT NULL,                                       -- toggl | harvest | clockify
  filename     text,
  rows_ok      integer NOT NULL DEFAULT 0,
  rows_failed  integer NOT NULL DEFAULT 0,
  errors       jsonb,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS audit_log (
  id             bigserial PRIMARY KEY,
  workspace_id   uuid REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id        uuid,
  tool_name      text NOT NULL,
  args           jsonb,
  result_summary text,
  ok             boolean NOT NULL DEFAULT true,
  duration_ms    integer,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS audit_log_ws_idx ON audit_log(workspace_id, created_at DESC);

-- ---------- OAuth 2.1 authorization server state ----------
CREATE TABLE IF NOT EXISTS oauth_clients (
  client_id     text PRIMARY KEY,
  client_secret text,
  metadata      jsonb NOT NULL,                                     -- full OAuthClientInformationFull
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS oauth_auth_requests (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id      text NOT NULL REFERENCES oauth_clients(client_id) ON DELETE CASCADE,
  redirect_uri   text NOT NULL,
  code_challenge text NOT NULL,
  scopes         text[] NOT NULL DEFAULT '{}',
  state          text,
  resource       text,
  user_id        uuid REFERENCES users(id) ON DELETE CASCADE,       -- set once identity is established
  expires_at     timestamptz NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS oauth_codes (
  code_hash      text PRIMARY KEY,
  auth_request_id uuid NOT NULL REFERENCES oauth_auth_requests(id) ON DELETE CASCADE,
  client_id      text NOT NULL,
  user_id        uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  workspace_id   uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  scopes         text[] NOT NULL,
  code_challenge text NOT NULL,
  redirect_uri   text NOT NULL,
  resource       text,
  used_at        timestamptz,
  expires_at     timestamptz NOT NULL
);

CREATE TABLE IF NOT EXISTS oauth_tokens (
  token_hash   text PRIMARY KEY,
  kind         text NOT NULL,                                       -- access | refresh
  client_id    text NOT NULL,
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  scopes       text[] NOT NULL,
  resource     text,
  family_id    uuid NOT NULL,                                       -- refresh-token rotation family
  expires_at   timestamptz NOT NULL,
  revoked_at   timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS oauth_tokens_family_idx ON oauth_tokens(family_id);

CREATE TABLE IF NOT EXISTS magic_links (
  token_hash text PRIMARY KEY,
  email      text NOT NULL,
  next_path  text,
  expires_at timestamptz NOT NULL,
  used_at    timestamptz
);

CREATE TABLE IF NOT EXISTS stripe_events (
  id         text PRIMARY KEY,
  type       text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
