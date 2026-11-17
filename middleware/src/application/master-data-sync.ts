/**
 * Master data synchronisation: upstream system → NetSuite (vendors and customers).
 *
 * FLOW for a batch of records:
 *   1. Validate and map every record (mapper). Invalid ones are reported and never sent to NetSuite.
 *   2. Upsert each valid record by externalId, with bounded concurrency. Each record runs as its own
 *      integration job with retries, so one failure does not stop the batch.
 *   3. Records that still fail go to the dead-letter queue, and can be replayed later.
 *
 * DUPLICATE PREVENTION: the upsert is keyed on externalId (PUT …/eid:CODE), so sending the same
 * vendor twice, or retrying after a timeout, updates the same record instead of creating a new one.
 */
import type { NetSuitePort } from './ports/netsuite';
import type { AuditService } from './audit';
import type { JobRunner } from './jobs';
import {
  mapBatch,
  mapCustomer,
  mapVendor,
  SourceCustomerSchema,
  SourceVendorSchema,
  type MappingFailure,
} from '../adapters/source/master-data-mapper';
import type { Customer, Vendor } from '../domain/types';
import { newId } from '../shared/util';

export const TOPIC_VENDOR_UPSERT = 'netsuite.vendor.upsert';
export const TOPIC_CUSTOMER_UPSERT = 'netsuite.customer.upsert';

export interface SyncItemResult {
  sourceRef: string;
  outcome: 'CREATED' | 'UPDATED' | 'FAILED' | 'INVALID';
  internalId?: string;
  jobId?: string;
  error?: string;
}

export interface SyncReport {
  received: number;
  created: number;
  updated: number;
  failed: number;
  invalid: number;
  items: SyncItemResult[];
}

/** Runs async tasks with at most `limit` in flight. WHY: NetSuite enforces per-account concurrency limits. */
export async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]!);
    }
  });
  await Promise.all(workers);
  return results;
}

export class MasterDataSyncService {
  constructor(
    private readonly netsuite: NetSuitePort,
    private readonly jobs: JobRunner,
    private readonly audit: AuditService,
    private readonly concurrency = 4,
  ) {
    // Handlers are what the DLQ replays, so they take the MAPPED domain record as payload.
    jobs.register(TOPIC_VENDOR_UPSERT, (p) => this.netsuite.upsertVendor(p as Vendor));
    jobs.register(TOPIC_CUSTOMER_UPSERT, (p) => this.netsuite.upsertCustomer(p as Customer));
  }

  syncVendors(rows: unknown[]): Promise<SyncReport> {
    const refOf = (r: unknown) => String((r as { vendor_code?: unknown })?.vendor_code ?? 'unknown');
    return this.sync(
      'vendor',
      rows,
      mapBatch(rows, SourceVendorSchema, mapVendor, refOf),
      TOPIC_VENDOR_UPSERT,
    );
  }

  syncCustomers(rows: unknown[]): Promise<SyncReport> {
    const refOf = (r: unknown) => String((r as { customer_code?: unknown })?.customer_code ?? 'unknown');
    return this.sync(
      'customer',
      rows,
      mapBatch(rows, SourceCustomerSchema, mapCustomer, refOf),
      TOPIC_CUSTOMER_UPSERT,
    );
  }

  private async sync<D extends { externalId: string }>(
    entity: string,
    rows: unknown[],
    mapped: { ok: { index: number; record: D }[]; failed: MappingFailure[] },
    topic: string,
  ): Promise<SyncReport> {
    const items: SyncItemResult[] = mapped.failed.map((f) => ({
      sourceRef: f.sourceRef,
      outcome: 'INVALID',
      error: f.errors.map((e) => `${e.path}: ${e.message}`).join('; '),
    }));

    const results = await mapWithConcurrency(mapped.ok, this.concurrency, async ({ record }) => {
      const job = await this.jobs.run(topic, record, { sourceRef: record.externalId });
      if (job.status === 'SUCCEEDED') {
        const r = job.result as { internalId: string; created: boolean };
        return {
          sourceRef: record.externalId,
          outcome: r.created ? 'CREATED' : 'UPDATED',
          internalId: r.internalId,
          jobId: job.id,
        } as SyncItemResult;
      }
      return {
        sourceRef: record.externalId,
        outcome: 'FAILED',
        jobId: job.id,
        error: job.error?.code,
      } as SyncItemResult;
    });
    items.push(...results);

    const count = (o: SyncItemResult['outcome']) => items.filter((i) => i.outcome === o).length;
    const report: SyncReport = {
      received: rows.length,
      created: count('CREATED'),
      updated: count('UPDATED'),
      failed: count('FAILED'),
      invalid: count('INVALID'),
      items,
    };
    await this.audit.record({
      action: `${entity.toUpperCase()}_SYNC`,
      entityType: `${entity}_sync`,
      entityId: newId('SYNC'),
      outcome: report.failed + report.invalid === 0 ? 'SUCCESS' : 'FAILURE',
      details: {
        received: report.received,
        created: report.created,
        updated: report.updated,
        failed: report.failed,
        invalid: report.invalid,
      },
    });
    return report;
  }
}
