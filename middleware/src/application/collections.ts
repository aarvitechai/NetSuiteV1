/**
 * Collections: aging report, reminder and escalation runs, and disputes.
 *
 * The aging report and the reminders read OPEN INVOICES FROM NETSUITE (the system of record), never a
 * local copy.
 *
 * COMMUNICATION AUDIT TRAIL: every reminder, escalation and dispute change is stored as a
 * collection_action (who, what, when, to whom, which template). WHY: if a customer says "you never told
 * me", or a regulator asks how collections are run, there is evidence.
 *
 * IDEMPOTENT RUNS: an action's id is `${invoice}:${stage}`. Running collections twice on the same day
 * (for example after a crash) does not send a second identical reminder.
 */
import type { AuditService } from './audit';
import type { NetSuitePort } from './ports/netsuite';
import type { Store } from './ports/store';
import { agingBucket, collectionStage, daysPastDue, STAGE_RANK, type AgingBucket } from '../domain/ar';
import { add, format, money } from '../domain/money';
import type { CollectionStage } from '../domain/types';
import { currentActor } from '../shared/context';
import { DuplicateKeyError } from '../shared/errors';
import { isoDate, type Clock } from '../shared/util';

/** Notification channel (email in production). RecordingNotifier just keeps messages in memory. */
export interface Notifier {
  send(msg: { to: string; template: string; data: Record<string, string> }): Promise<void>;
}

export class RecordingNotifier implements Notifier {
  readonly sent: { to: string; template: string; data: Record<string, string> }[] = [];
  async send(msg: { to: string; template: string; data: Record<string, string> }): Promise<void> {
    this.sent.push(msg);
  }
}

export interface CollectionAction {
  id: string;
  invoiceExternalId: string;
  customerExternalId: string;
  stage: CollectionStage;
  type: 'REMINDER' | 'ESCALATION' | 'DISPUTE_OPENED' | 'DISPUTE_CLOSED';
  channel: 'email' | 'internal';
  to: string;
  template: string;
  at: string;
  actor: string;
  note?: string;
}

const TEMPLATE: Record<
  Exclude<CollectionStage, 'NONE'>,
  { template: string; type: CollectionAction['type'] }
> = {
  REMINDER_1: { template: 'nsd-friendly-reminder', type: 'REMINDER' },
  REMINDER_2: { template: 'nsd-second-notice', type: 'REMINDER' },
  ESCALATED: { template: 'nsd-escalation-ar-manager', type: 'ESCALATION' },
};

const BUCKETS: AgingBucket[] = ['CURRENT', '1-30', '31-60', '61-90', '90+'];

export class CollectionsService {
  constructor(
    private readonly netsuite: NetSuitePort,
    private readonly store: Store,
    private readonly audit: AuditService,
    private readonly notifier: Notifier,
    private readonly clock: Clock,
  ) {}

  private actions() {
    return this.store.repo<CollectionAction>('collection_actions');
  }

  async aging(asOf = isoDate(this.clock.now())) {
    const [invoices, customers] = await Promise.all([
      this.netsuite.listOpenInvoices(),
      this.netsuite.listCustomers(),
    ]);
    const names = new Map(customers.map((c) => [c.externalId, c.companyName]));
    const zero = (cur: string) => Object.fromEntries(BUCKETS.map((b) => [b, money('0', cur)]));
    const perCustomer = new Map<
      string,
      { currency: string; buckets: Record<string, ReturnType<typeof money>> }
    >();
    const totals = new Map<string, Record<string, ReturnType<typeof money>>>();

    for (const inv of invoices) {
      const bucket = agingBucket(daysPastDue(inv.dueDate, asOf));
      const key = `${inv.customerExternalId}|${inv.currency}`;
      const row = perCustomer.get(key) ?? { currency: inv.currency, buckets: zero(inv.currency) };
      row.buckets[bucket] = add(row.buckets[bucket]!, money(inv.amountRemaining, inv.currency));
      perCustomer.set(key, row);
      const t = totals.get(inv.currency) ?? zero(inv.currency);
      t[bucket] = add(t[bucket]!, money(inv.amountRemaining, inv.currency));
      totals.set(inv.currency, t);
    }

    const fmt = (b: Record<string, ReturnType<typeof money>>, currency: string) => {
      const out: Record<string, string> = Object.fromEntries(BUCKETS.map((k) => [k, format(b[k]!)]));
      out.TOTAL = format(BUCKETS.reduce((s, k) => add(s, b[k]!), money('0', currency)));
      return out;
    };
    return {
      asOf,
      totals: Object.fromEntries([...totals].map(([cur, b]) => [cur, fmt(b, cur)])),
      customers: [...perCustomer].map(([key, row]) => {
        const id = key.split('|')[0]!;
        return {
          customerExternalId: id,
          name: names.get(id) ?? id,
          currency: row.currency,
          buckets: fmt(row.buckets, row.currency),
        };
      }),
    };
  }

  async run(asOf = isoDate(this.clock.now())) {
    const invoices = await this.netsuite.listOpenInvoices();
    const customers = new Map((await this.netsuite.listCustomers()).map((c) => [c.externalId, c]));
    const summary = {
      asOf,
      evaluated: invoices.length,
      reminders: 0,
      escalations: 0,
      skippedDisputed: 0,
      unchanged: 0,
    };

    for (const inv of invoices) {
      const stage = collectionStage(daysPastDue(inv.dueDate, asOf), inv.disputed);
      if (inv.disputed) {
        summary.skippedDisputed++;
        continue;
      }
      // Never move a stage backwards automatically, and never repeat the same stage.
      if (stage === 'NONE' || STAGE_RANK[stage] <= STAGE_RANK[inv.collectionStage]) {
        summary.unchanged++;
        continue;
      }
      const customer = customers.get(inv.customerExternalId);
      const t = TEMPLATE[stage];
      const action: CollectionAction = {
        id: `${inv.externalId}:${stage}`,
        invoiceExternalId: inv.externalId,
        customerExternalId: inv.customerExternalId,
        stage,
        type: t.type,
        channel: stage === 'ESCALATED' ? 'internal' : 'email',
        to: stage === 'ESCALATED' ? 'ar-manager@northstar.example' : (customer?.email ?? 'unknown'),
        template: t.template,
        at: this.clock.now().toISOString(),
        actor: currentActor(),
      };
      try {
        await this.actions().insert(action);
      } catch (e) {
        if (e instanceof DuplicateKeyError) {
          summary.unchanged++;
          continue;
        }
        throw e;
      }
      await this.notifier.send({
        to: action.to,
        template: action.template,
        data: {
          invoice: inv.tranId,
          amount: inv.amountRemaining,
          currency: inv.currency,
          dueDate: inv.dueDate,
        },
      });
      await this.netsuite.setInvoiceCollectionStage(inv.externalId, stage);
      await this.audit.record({
        action: `COLLECTIONS_${t.type}`,
        entityType: 'invoice',
        entityId: inv.externalId,
        outcome: 'SUCCESS',
        details: { stage, template: t.template },
      });
      if (t.type === 'ESCALATION') summary.escalations++;
      else summary.reminders++;
    }
    return summary;
  }

  async setDispute(invoiceExternalId: string, disputed: boolean, note: string) {
    const inv = await this.netsuite.getInvoice(invoiceExternalId);
    await this.netsuite.setInvoiceDispute(invoiceExternalId, disputed);
    const action: CollectionAction = {
      id: `${invoiceExternalId}:${disputed ? 'DISPUTE_OPENED' : 'DISPUTE_CLOSED'}:${this.clock.now().getTime()}`,
      invoiceExternalId,
      customerExternalId: inv?.customerExternalId ?? 'unknown',
      stage: inv?.collectionStage ?? 'NONE',
      type: disputed ? 'DISPUTE_OPENED' : 'DISPUTE_CLOSED',
      channel: 'internal',
      to: 'ar-team',
      template: 'n/a',
      at: this.clock.now().toISOString(),
      actor: currentActor(),
      note,
    };
    await this.actions().insert(action);
    await this.audit.record({
      action: action.type,
      entityType: 'invoice',
      entityId: invoiceExternalId,
      outcome: 'SUCCESS',
      details: { note },
    });
    return action;
  }

  history(filter: { invoiceExternalId?: string; customerExternalId?: string }) {
    const f = filter.invoiceExternalId
      ? { invoiceExternalId: filter.invoiceExternalId }
      : filter.customerExternalId
        ? { customerExternalId: filter.customerExternalId }
        : {};
    return this.actions().list(f);
  }
}
