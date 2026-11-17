-- 002: look up payment batches by their bank reference (bank ACK/STATUS files carry only batchRef).
-- WHY a migration and not an edit of 001: 001 has already been applied in existing databases.
-- Migrations are append-only; the runner applies only files it has not seen yet.
-- UNIQUE also guarantees two batches can never share a reference.
CREATE UNIQUE INDEX IF NOT EXISTS ux_payment_batches_batchref ON payment_batches ((data->>'batchRef'));
