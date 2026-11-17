import { describe, expect, it } from 'vitest';
import {
  canTransition,
  InvalidTransitionError,
  isTerminal,
  PAYMENT_STATES,
  transition,
} from '../../src/domain/payment-state';

describe('payment state machine', () => {
  it('allows the happy path Draft → … → Reconciled', () => {
    const path = [
      'Draft',
      'Validated',
      'Approved',
      'Submitted',
      'Accepted',
      'Settled',
      'Reconciled',
    ] as const;
    for (let i = 0; i < path.length - 1; i++) {
      expect(canTransition(path[i]!, path[i + 1]!)).toBe(true);
    }
  });

  it('forbids skipping approval', () => {
    expect(canTransition('Validated', 'Submitted')).toBe(false);
    expect(canTransition('Draft', 'Settled')).toBe(false);
  });

  it('handles a return after settlement, then reversal', () => {
    expect(canTransition('Settled', 'Returned')).toBe(true);
    expect(canTransition('Reconciled', 'Returned')).toBe(true);
    expect(canTransition('Returned', 'Reversed')).toBe(true);
  });

  it('treats Failed and Reversed as terminal', () => {
    expect(isTerminal('Failed')).toBe(true);
    expect(isTerminal('Reversed')).toBe(true);
    for (const s of PAYMENT_STATES) expect(canTransition('Failed', s)).toBe(false);
  });

  it('records actor and timestamp, throws on illegal moves', () => {
    const now = new Date('2026-01-15T10:00:00Z');
    expect(transition('Validated', 'Approved', 'bob', 'ok', now)).toEqual({
      from: 'Validated',
      to: 'Approved',
      at: '2026-01-15T10:00:00.000Z',
      actor: 'bob',
      reason: 'ok',
    });
    expect(() => transition('Approved', 'Settled', 'x')).toThrow(InvalidTransitionError);
  });
});
