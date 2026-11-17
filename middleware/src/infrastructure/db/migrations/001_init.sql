-- 001_init.sql: integration metadata schema (NOT a general ledger - see ADR-0001).
-- Each table: id (primary key, enforces uniqueness for idempotency/dedupe), data (JSONB entity),
-- timestamps, and expression indexes on the fields the application filters by.

CREATE TABLE IF NOT EXISTS schema_migrations (
  version TEXT PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One unit of integration work (sync, payment submission...) with attempts and status.
CREATE TABLE IF NOT EXISTS integration_jobs (
  id TEXT PRIMARY KEY,
  data JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_integration_jobs_type ON integration_jobs ((data->>'type'));
CREATE INDEX IF NOT EXISTS ix_integration_jobs_status ON integration_jobs ((data->>'status'));
CREATE INDEX IF NOT EXISTS ix_integration_jobs_correlationid ON integration_jobs ((data->>'correlationId'));

-- Idempotency key -> payload hash and stored response, so retried requests return the same result.
CREATE TABLE IF NOT EXISTS idempotency_records (
  id TEXT PRIMARY KEY,
  data JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_idempotency_records_operation ON idempotency_records ((data->>'operation'));
CREATE INDEX IF NOT EXISTS ix_idempotency_records_status ON idempotency_records ((data->>'status'));

-- Every provider webhook received (id = provider event id) - the inbox that makes duplicates harmless.
CREATE TABLE IF NOT EXISTS webhook_receipts (
  id TEXT PRIMARY KEY,
  data JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_webhook_receipts_provider ON webhook_receipts ((data->>'provider'));
CREATE INDEX IF NOT EXISTS ix_webhook_receipts_status ON webhook_receipts ((data->>'status'));

-- Who did what, when, with which outcome. Append-only.
CREATE TABLE IF NOT EXISTS audit_events (
  id TEXT PRIMARY KEY,
  data JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_audit_events_entitytype ON audit_events ((data->>'entityType'));
CREATE INDEX IF NOT EXISTS ix_audit_events_entityid ON audit_events ((data->>'entityId'));
CREATE INDEX IF NOT EXISTS ix_audit_events_correlationid ON audit_events ((data->>'correlationId'));
CREATE INDEX IF NOT EXISTS ix_audit_events_action ON audit_events ((data->>'action'));

-- Links our entities to bank/provider references.
CREATE TABLE IF NOT EXISTS provider_references (
  id TEXT PRIMARY KEY,
  data JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_provider_references_entitytype ON provider_references ((data->>'entityType'));
CREATE INDEX IF NOT EXISTS ix_provider_references_entityid ON provider_references ((data->>'entityId'));
CREATE INDEX IF NOT EXISTS ix_provider_references_provider ON provider_references ((data->>'provider'));

-- Messages saved in the same transaction as the business change, published afterwards.
CREATE TABLE IF NOT EXISTS outbox_messages (
  id TEXT PRIMARY KEY,
  data JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_outbox_messages_status ON outbox_messages ((data->>'status'));
CREATE INDEX IF NOT EXISTS ix_outbox_messages_topic ON outbox_messages ((data->>'topic'));

-- Messages that failed permanently or exhausted retries, waiting for a human.
CREATE TABLE IF NOT EXISTS dead_letters (
  id TEXT PRIMARY KEY,
  data JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_dead_letters_status ON dead_letters ((data->>'status'));
CREATE INDEX IF NOT EXISTS ix_dead_letters_topic ON dead_letters ((data->>'topic'));

-- AP payment batches (maker-checker, immutable after approval).
CREATE TABLE IF NOT EXISTS payment_batches (
  id TEXT PRIMARY KEY,
  data JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_payment_batches_status ON payment_batches ((data->>'status'));
CREATE INDEX IF NOT EXISTS ix_payment_batches_rail ON payment_batches ((data->>'rail'));
CREATE INDEX IF NOT EXISTS ix_payment_batches_currency ON payment_batches ((data->>'currency'));

-- One payment to one counterparty inside a batch.
CREATE TABLE IF NOT EXISTS payment_instructions (
  id TEXT PRIMARY KEY,
  data JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_payment_instructions_batchid ON payment_instructions ((data->>'batchId'));
CREATE INDEX IF NOT EXISTS ix_payment_instructions_status ON payment_instructions ((data->>'status'));
CREATE INDEX IF NOT EXISTS ix_payment_instructions_counterpartyexternalid ON payment_instructions ((data->>'counterpartyExternalId'));

-- AR online payment attempts (hosted checkout).
CREATE TABLE IF NOT EXISTS payment_intents (
  id TEXT PRIMARY KEY,
  data JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_payment_intents_customerexternalid ON payment_intents ((data->>'customerExternalId'));
CREATE INDEX IF NOT EXISTS ix_payment_intents_status ON payment_intents ((data->>'status'));
CREATE INDEX IF NOT EXISTS ix_payment_intents_providerref ON payment_intents ((data->>'providerRef'));

-- Provider/bank settlement records: gross, fees, net.
CREATE TABLE IF NOT EXISTS settlements (
  id TEXT PRIMARY KEY,
  data JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_settlements_provider ON settlements ((data->>'provider'));
CREATE INDEX IF NOT EXISTS ix_settlements_status ON settlements ((data->>'status'));

-- Every inbound/outbound bank file with SHA-256 checksum (duplicate detection, archive).
CREATE TABLE IF NOT EXISTS bank_files (
  id TEXT PRIMARY KEY,
  data JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_bank_files_direction ON bank_files ((data->>'direction'));
CREATE INDEX IF NOT EXISTS ix_bank_files_status ON bank_files ((data->>'status'));
CREATE INDEX IF NOT EXISTS ix_bank_files_checksum ON bank_files ((data->>'checksum'));

-- Parsed bank statement lines.
CREATE TABLE IF NOT EXISTS bank_lines (
  id TEXT PRIMARY KEY,
  data JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_bank_lines_fileid ON bank_lines ((data->>'fileId'));
CREATE INDEX IF NOT EXISTS ix_bank_lines_status ON bank_lines ((data->>'status'));
CREATE INDEX IF NOT EXISTS ix_bank_lines_reference ON bank_lines ((data->>'reference'));

-- Reconciliation match suggestions and decisions.
CREATE TABLE IF NOT EXISTS recon_matches (
  id TEXT PRIMARY KEY,
  data JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_recon_matches_banklineid ON recon_matches ((data->>'bankLineId'));
CREATE INDEX IF NOT EXISTS ix_recon_matches_status ON recon_matches ((data->>'status'));

-- Collections reminders/escalations sent (communication audit trail).
CREATE TABLE IF NOT EXISTS collection_actions (
  id TEXT PRIMARY KEY,
  data JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_collection_actions_invoiceexternalid ON collection_actions ((data->>'invoiceExternalId'));
CREATE INDEX IF NOT EXISTS ix_collection_actions_customerexternalid ON collection_actions ((data->>'customerExternalId'));
CREATE INDEX IF NOT EXISTS ix_collection_actions_stage ON collection_actions ((data->>'stage'));

-- Audit events are append-only: block UPDATE and DELETE at the database level.
CREATE OR REPLACE FUNCTION forbid_audit_change() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'audit_events is append-only';
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS trg_audit_append_only ON audit_events;
CREATE TRIGGER trg_audit_append_only BEFORE UPDATE OR DELETE ON audit_events
  FOR EACH ROW EXECUTE FUNCTION forbid_audit_change();
