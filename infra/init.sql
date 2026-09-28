-- Audit schema. Postgres runs this once, the first time its data volume is created
-- (mounted into /docker-entrypoint-initdb.d). Tables match spec §8.3; input_events
-- is an addition for spec §12.2 (server-side log of the operator's injected input).

CREATE TABLE sessions (
  id            UUID PRIMARY KEY,
  operator      TEXT NOT NULL,
  target        TEXT NOT NULL,
  reason        TEXT,
  scope         TEXT NOT NULL DEFAULT 'control',
  state         TEXT NOT NULL,
  recording_url TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  ended_at      TIMESTAMPTZ
);

CREATE TABLE audit_events (
  id          BIGSERIAL PRIMARY KEY,
  session_id  UUID REFERENCES sessions(id),
  event       TEXT NOT NULL,        -- requested|consent_shown|consent_granted|
                                    -- consent_denied|token_issued|recording_started|
                                    -- connected|control_granted|scope_changed|
                                    -- disconnected|recording_stopped|ended
  detail      JSONB,
  at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX audit_events_session_idx ON audit_events (session_id, at);

-- Every data-channel message the operator sent, captured by the broker's hidden
-- "audit-tap" participant in the LiveKit room (not by either client, so neither
-- side can omit it). Mouse moves are included; they are small and make replay possible.
CREATE TABLE input_events (
  id          BIGSERIAL PRIMARY KEY,
  session_id  UUID NOT NULL REFERENCES sessions(id),
  sender      TEXT NOT NULL,
  msg         JSONB NOT NULL,
  at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX input_events_session_idx ON input_events (session_id, at);

-- The audit trail is append-only: no one, including the broker, may rewrite history.
CREATE FUNCTION forbid_audit_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'audit tables are append-only';
END $$ LANGUAGE plpgsql;

CREATE TRIGGER audit_events_append_only BEFORE UPDATE OR DELETE ON audit_events
  FOR EACH ROW EXECUTE FUNCTION forbid_audit_mutation();
CREATE TRIGGER input_events_append_only BEFORE UPDATE OR DELETE ON input_events
  FOR EACH ROW EXECUTE FUNCTION forbid_audit_mutation();
