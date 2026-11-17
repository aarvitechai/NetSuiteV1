/**
 * Webhook intake: VERIFY → PERSIST → ACKNOWLEDGE QUICKLY → PROCESS ASYNCHRONOUSLY.
 *
 * WHY THIS ORDER
 *  1. Verify the signature first: unsigned or forged requests never touch the database.
 *  2. Persist a receipt keyed by the provider's EVENT ID (the inbox pattern). A second delivery of the
 *     same event hits the unique key and is acknowledged without doing anything. That is how "the
 *     provider sent it twice" becomes harmless.
 *  3. Acknowledge (202) immediately. Providers time out after a few seconds and then RETRY. If we did slow
 *     NetSuite work before answering, we would receive even more duplicates.
 *  4. Process afterwards, as a job with retries and the DLQ. A failure there does not lose the event:
 *     it is stored and can be replayed.
 */
import type { Logger } from 'pino';
import type { ArPaymentService } from './ar-payments';
import type { AuditService } from './audit';
import type { JobRunner } from './jobs';
import { WebhookEventSchema, type WebhookEvent } from './ports/payment-provider';
import type { Store } from './ports/store';
import { verifySignature } from '../adapters/payment-provider/webhook-signature';
import { runWithContext } from '../shared/context';
import { AppError, DuplicateKeyError, NotFoundError, ValidationError } from '../shared/errors';
import type { Clock } from '../shared/util';

export const TOPIC_PROCESS_WEBHOOK = 'webhook.process';

export interface WebhookReceipt {
  id: string; // provider event id
  provider: string;
  type: string;
  status: 'RECEIVED' | 'PROCESSED' | 'FAILED';
  receivedAt: string;
  processedAt?: string;
  result?: string;
  /** The verified event. It contains references and amounts only, never card data. */
  event: WebhookEvent;
}

export class WebhookSignatureError extends AppError {
  constructor(reason: string) {
    super('WEBHOOK_SIGNATURE_INVALID', `Webhook signature rejected (${reason})`, 401);
  }
}

export class WebhookService {
  private readonly inflight = new Set<Promise<unknown>>();

  constructor(
    private readonly store: Store,
    private readonly ar: ArPaymentService,
    private readonly jobs: JobRunner,
    private readonly audit: AuditService,
    private readonly clock: Clock,
    private readonly logger: Logger,
    private readonly secret: string,
    private readonly provider: string,
  ) {
    jobs.register(TOPIC_PROCESS_WEBHOOK, (p) => this.process((p as { receiptId: string }).receiptId));
  }

  private repo() {
    return this.store.repo<WebhookReceipt>('webhook_receipts');
  }

  async receive(
    rawBody: string,
    signatureHeader: string | undefined,
  ): Promise<{ status: 'accepted' | 'duplicate'; eventId: string }> {
    const v = verifySignature(
      this.secret,
      rawBody,
      signatureHeader,
      Math.floor(this.clock.now().getTime() / 1000),
    );
    if (!v.ok) {
      // Log without the body. Repeated failures may mean an attack or a rotated secret.
      this.logger.warn({ reason: v.reason }, 'webhook signature rejected');
      await this.audit.record({
        action: 'WEBHOOK_SIGNATURE_INVALID',
        entityType: 'webhook',
        entityId: 'unknown',
        outcome: 'REJECTED',
        source: 'webhook',
        actor: `webhook:${this.provider}`,
        details: { reason: v.reason },
      });
      throw new WebhookSignatureError(v.reason);
    }

    let event: WebhookEvent;
    try {
      event = WebhookEventSchema.parse(JSON.parse(rawBody));
    } catch {
      throw new ValidationError('Webhook payload does not match a supported event type/version');
    }

    const receipt: WebhookReceipt = {
      id: event.id,
      provider: this.provider,
      type: event.type,
      status: 'RECEIVED',
      receivedAt: this.clock.now().toISOString(),
      event,
    };
    try {
      await this.repo().insert(receipt);
    } catch (e) {
      if (e instanceof DuplicateKeyError) {
        this.logger.info({ eventId: event.id }, 'duplicate webhook delivery ignored');
        return { status: 'duplicate', eventId: event.id };
      }
      throw e;
    }

    // Asynchronous processing, under a correlation ID derived from the event (traceable end to end).
    const p = runWithContext({ correlationId: `wh-${event.id}`, actor: `webhook:${this.provider}` }, () =>
      this.jobs.run(TOPIC_PROCESS_WEBHOOK, { receiptId: event.id }, { sourceRef: event.id }),
    ).finally(() => this.inflight.delete(p));
    this.inflight.add(p);
    return { status: 'accepted', eventId: event.id };
  }

  /** Waits for background processing. Used by tests, the demo and graceful shutdown. */
  async drain(): Promise<void> {
    while (this.inflight.size) await Promise.allSettled([...this.inflight]);
  }

  private async process(receiptId: string): Promise<string> {
    const r = await this.repo().get(receiptId);
    if (!r) throw new NotFoundError(`Webhook receipt ${receiptId}`);
    if (r.status === 'PROCESSED') return r.result ?? 'already processed';
    try {
      const result = await this.ar.handleEvent(r.event);
      await this.repo().upsert({
        ...r,
        status: 'PROCESSED',
        processedAt: this.clock.now().toISOString(),
        result,
      });
      return result;
    } catch (e) {
      await this.repo().upsert({ ...r, status: 'FAILED', result: (e as Error).message });
      throw e;
    }
  }
}
