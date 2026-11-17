/**
 * Inbound bank file processing: picks up files the bank dropped into SFTP `inbound/`.
 *
 * For each file:
 *   1. Compute its SHA-256. If we already processed a file with the same checksum, it is a DUPLICATE:
 *      archive it and do nothing else. (Banks do resend files, so this is expected.)
 *   2. Detect the type and validate it: ACK, PAYMENT_STATUS (JSON), or a statement (CSV / camt.053 XML,
 *      handled by the reconciliation service in Phase 10).
 *   3. Route it to the right handler.
 *   4. Outcome:
 *        - success                          → archive/inbound
 *        - unparseable or unknown file      → quarantine, for a human to look at
 *        - transient error (NetSuite down)  → leave the file in inbound and try again on the next poll
 *
 * Every file gets a bank_files record. That record is the audit evidence of what we received and when.
 */
import type { Logger } from 'pino';
import type { ApPaymentService } from './ap-payments';
import type { AuditService } from './audit';
import type { Store } from './ports/store';
import { AckFileSchema, StatusFileSchema } from '../adapters/bank/payment-files';
import type { BankFileRecord } from '../domain/bank-file';
import type { FileTransport } from '../infrastructure/files/file-transport';
import { isTransient } from '../shared/errors';
import { newId, sha256, type Clock } from '../shared/util';

/** Statement handler plugged in by the reconciliation service (Phase 10). */
export type StatementHandler = (name: string, content: string, fileId: string) => Promise<unknown>;

export interface PollResult {
  name: string;
  status: BankFileRecord['status'] | 'RETRY_LATER';
  fileType?: string;
  result?: unknown;
  error?: string;
}

export class BankInboundService {
  private statementHandler?: StatementHandler;

  constructor(
    private readonly files: FileTransport,
    private readonly store: Store,
    private readonly ap: ApPaymentService,
    private readonly audit: AuditService,
    private readonly clock: Clock,
    private readonly logger: Logger,
  ) {}

  onStatement(handler: StatementHandler): void {
    this.statementHandler = handler;
  }

  private repo() {
    return this.store.repo<BankFileRecord>('bank_files');
  }

  /** Puts a file received by other means (e.g. an upload API) into inbound and processes it like any SFTP file. */
  async ingest(name: string, content: string): Promise<PollResult> {
    await this.files.put('inbound', name, content);
    return this.processOne(name);
  }

  /**
   * Replays a QUARANTINED file after the cause was fixed (e.g. a parser bug was deployed, or the bank
   * resent a corrected file under the same name). It moves the file back to inbound and processes it again.
   */
  async replayQuarantined(name: string): Promise<PollResult> {
    await this.files.move('quarantine', name, 'inbound');
    await this.audit.record({
      action: 'BANK_FILE_REPLAY',
      entityType: 'bank_file',
      entityId: name,
      outcome: 'SUCCESS',
      source: 'bank-inbound',
    });
    return this.processOne(name);
  }

  listQuarantined(): Promise<string[]> {
    return this.files.list('quarantine');
  }

  async poll(): Promise<PollResult[]> {
    const results: PollResult[] = [];
    for (const name of await this.files.list('inbound')) results.push(await this.processOne(name));
    return results;
  }

  private async processOne(name: string): Promise<PollResult> {
    const content = await this.files.get('inbound', name);
    const checksum = sha256(content);
    const record: BankFileRecord = {
      id: newId('BF'),
      direction: 'INBOUND',
      status: 'PROCESSED',
      name,
      checksum,
      receivedAt: this.clock.now().toISOString(),
    };

    const previous = (await this.repo().list({ checksum })).find(
      (f) => f.direction === 'INBOUND' && f.status === 'PROCESSED',
    );
    if (previous) {
      await this.repo().insert({ ...record, status: 'DUPLICATE', error: `duplicate of ${previous.id}` });
      await this.files.move('inbound', name, 'archive/inbound');
      this.logger.warn({ name, duplicateOf: previous.id }, 'duplicate bank file skipped');
      return { name, status: 'DUPLICATE' };
    }

    try {
      const { fileType, result } = await this.route(name, content, record.id);
      await this.repo().insert({ ...record, fileType, result });
      await this.files.move('inbound', name, 'archive/inbound');
      await this.audit.record({
        action: 'BANK_FILE_PROCESSED',
        entityType: 'bank_file',
        entityId: record.id,
        outcome: 'SUCCESS',
        source: 'bank-inbound',
        details: { name, fileType, checksum },
      });
      return { name, status: 'PROCESSED', fileType, result };
    } catch (e) {
      if (isTransient(e)) {
        // Do not record and do not move: the next poll retries this file.
        this.logger.warn(
          { name, err: (e as Error).message },
          'transient error processing bank file; will retry',
        );
        return { name, status: 'RETRY_LATER', error: (e as Error).message };
      }
      const error = (e as Error).message;
      await this.repo().insert({ ...record, status: 'QUARANTINED', error });
      await this.files.move('inbound', name, 'quarantine');
      await this.audit.record({
        action: 'BANK_FILE_QUARANTINED',
        entityType: 'bank_file',
        entityId: record.id,
        outcome: 'FAILURE',
        source: 'bank-inbound',
        details: { name, error },
      });
      return { name, status: 'QUARANTINED', error };
    }
  }

  private async route(
    name: string,
    content: string,
    fileId: string,
  ): Promise<{ fileType: string; result: unknown }> {
    if (name.endsWith('.json')) {
      let json: unknown;
      try {
        json = JSON.parse(content);
      } catch {
        throw new Error('FILE_PARSE_ERROR: invalid JSON');
      }
      const type = (json as { type?: string })?.type;
      if (type === 'ACK')
        return { fileType: 'ACK', result: await this.ap.handleAck(AckFileSchema.parse(json)) };
      if (type === 'PAYMENT_STATUS')
        return {
          fileType: 'PAYMENT_STATUS',
          result: await this.ap.handleStatus(StatusFileSchema.parse(json)),
        };
      throw new Error(`FILE_PARSE_ERROR: unknown JSON file type "${String(type)}"`);
    }
    if ((name.endsWith('.csv') || name.endsWith('.xml')) && this.statementHandler) {
      return { fileType: 'STATEMENT', result: await this.statementHandler(name, content, fileId) };
    }
    throw new Error(`FILE_PARSE_ERROR: unsupported file "${name}"`);
  }
}
