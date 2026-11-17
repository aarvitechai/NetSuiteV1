import { describe, expect, it } from 'vitest';
import { IdempotencyService } from '../../src/application/idempotency';
import { MemoryStore } from '../../src/infrastructure/memory/memory-store';
import { BusinessRuleError, TransientError } from '../../src/shared/errors';
import { fixedClock } from '../../src/shared/util';

describe('IdempotencyService', () => {
  const setup = () => {
    const clock = fixedClock('2026-11-20T00:00:00Z');
    return { svc: new IdempotencyService(new MemoryStore(), clock), clock };
  };

  it('runs once and replays the stored response', async () => {
    const { svc } = setup();
    let runs = 0;
    const fn = async () => ({ status: 201, body: { id: ++runs } });
    const first = await svc.execute('op', 'k1', { a: 1 }, fn);
    const second = await svc.execute('op', 'k1', { a: 1 }, fn);
    expect(first).toEqual({ status: 201, body: { id: 1 }, replayed: false });
    expect(second).toEqual({ status: 201, body: { id: 1 }, replayed: true });
    expect(runs).toBe(1);
  });

  it('treats payloads with different key order as identical', async () => {
    const { svc } = setup();
    await svc.execute('op', 'k', { a: 1, b: 2 }, async () => ({ status: 200, body: 'x' }));
    await expect(
      svc.execute('op', 'k', { b: 2, a: 1 }, async () => ({ status: 200, body: 'y' })),
    ).resolves.toMatchObject({ body: 'x' });
  });

  it('rejects key reuse with a different payload', async () => {
    const { svc } = setup();
    await svc.execute('op', 'k', { a: 1 }, async () => ({ status: 200, body: null }));
    await expect(
      svc.execute('op', 'k', { a: 2 }, async () => ({ status: 200, body: null })),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
  });

  it('rejects a concurrent duplicate while the first is in progress', async () => {
    const { svc } = setup();
    let release!: () => void;
    const slow = svc.execute<number>(
      'op',
      'k',
      {},
      () =>
        new Promise<{ status: number; body: number }>((r) => (release = () => r({ status: 200, body: 1 }))),
    );
    await new Promise((r) => setTimeout(r, 0));
    await expect(svc.execute('op', 'k', {}, async () => ({ status: 200, body: 2 }))).rejects.toMatchObject({
      code: 'IDEMPOTENCY_IN_PROGRESS',
    });
    release();
    await slow;
  });

  it('forgets the key after a transient failure so the client can retry', async () => {
    const { svc } = setup();
    await expect(
      svc.execute('op', 'k', {}, async () => Promise.reject(new TransientError('X', 'down'))),
    ).rejects.toThrow('down');
    await expect(
      svc.execute('op', 'k', {}, async () => ({ status: 200, body: 'ok' })),
    ).resolves.toMatchObject({ body: 'ok', replayed: false });
  });

  it('remembers permanent business errors', async () => {
    const { svc } = setup();
    let runs = 0;
    const fail = async () => {
      runs++;
      throw new BusinessRuleError('NOPE', 'no');
    };
    await expect(svc.execute('op', 'k', {}, fail)).rejects.toThrow('no');
    await expect(svc.execute('op', 'k', {}, fail)).resolves.toMatchObject({ status: 422, replayed: true });
    expect(runs).toBe(1);
  });

  it('treats expired keys as new', async () => {
    const { svc, clock } = setup();
    await svc.execute('op', 'k', {}, async () => ({ status: 200, body: 1 }));
    clock.advance(31 * 24 * 3600 * 1000);
    await expect(svc.execute('op', 'k', {}, async () => ({ status: 200, body: 2 }))).resolves.toMatchObject({
      body: 2,
      replayed: false,
    });
  });
});
