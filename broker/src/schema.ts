// Tables for invite-link onboarding. Idempotent and run at every broker start, so an
// existing Postgres volume (where infra/init.sql already ran) picks them up without a reset.
//
//   invites       one row per link an operator creates. Only the SHA-256 of the token is stored,
//                 so a database leak does not leak usable links.
//   devices       one row per enrolled computer: its own credential (hashed) bound to ONE target id,
//                 replacing the shared ENDPOINT_SECRET for clients that enrolled through a link.
//   invite_events append-only trail of what happened to a link (created, opened, enrolled, ...).
import { db } from './db.js';

const DDL = `
CREATE TABLE IF NOT EXISTS invites (
  id          UUID PRIMARY KEY,
  token_hash  TEXT NOT NULL UNIQUE,
  created_by  TEXT NOT NULL,
  note        TEXT,
  base_url    TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at  TIMESTAMPTZ NOT NULL,
  opened_at   TIMESTAMPTZ,
  enrolled_at TIMESTAMPTZ,
  revoked_at  TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS devices (
  id              UUID PRIMARY KEY,
  invite_id       UUID REFERENCES invites(id),
  target_id       TEXT NOT NULL UNIQUE,
  credential_hash TEXT NOT NULL UNIQUE,
  platform        TEXT NOT NULL,
  hostname        TEXT,
  enrolled_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at    TIMESTAMPTZ,
  revoked_at      TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS invite_events (
  id         BIGSERIAL PRIMARY KEY,
  invite_id  UUID REFERENCES invites(id),
  event      TEXT NOT NULL,
  detail     JSONB,
  at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE OR REPLACE FUNCTION forbid_invite_event_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'invite_events is append-only';
END $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS invite_events_append_only ON invite_events;
CREATE TRIGGER invite_events_append_only BEFORE UPDATE OR DELETE ON invite_events
  FOR EACH ROW EXECUTE FUNCTION forbid_invite_event_mutation();
`;

export async function ensureSchema() {
  await db.query(DDL);
}
