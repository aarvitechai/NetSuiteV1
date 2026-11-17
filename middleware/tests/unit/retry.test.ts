import { describe, expect, it } from 'vitest';
import { backoffDelay, RetriesExhaustedError, withRetry } from '../../src/application/retry';
import { BusinessRuleError, TransientError } from '../../src/shared/errors';

const policy = { maxAttempts: 4, baseDelayMs: 100, maxDelayMs: 1000 };

describe('withRetry', () => {
  it('retries transient errors and then succeeds', async () => {
    const sleeps: number[] = [];
    let calls = 0;
    const result = await withRetry(
      async () => {
        if (++calls < 3) throw new TransientError('X', 'blip');
        return 'ok';
      },
      policy,
      { sleep: async (ms) => void sleeps.push(ms), random: () => 1 },
    );
    expect(result).toBe('ok');
    expect(calls).toBe(3);
    expect(sleeps).toEqual([100, 200]); // exponential: 100·2^0, 100·2^1
  });

  it('never retries permanent errors', async () => {
    let calls = 0;
    await expect(
      withRetry(
        async () => {
          calls++;
          throw new BusinessRuleError('BAD', 'bad data');
        },
        policy,
        { sleep: async () => undefined },
      ),
    ).rejects.toBeInstanceOf(BusinessRuleError);
    expect(calls).toBe(1);
  });

  it('gives up after maxAttempts with RetriesExhaustedError', async () => {
    let calls = 0;
    const p = withRetry(
      async () => {
        calls++;
        throw new TransientError('X', 'down');
      },
      policy,
      { sleep: async () => undefined },
    );
    await expect(p).rejects.toBeInstanceOf(RetriesExhaustedError);
    expect(calls).toBe(4);
  });

  it('honours Retry-After from the server', async () => {
    const sleeps: number[] = [];
    let calls = 0;
    await withRetry(
      async () => {
        if (++calls === 1) throw new TransientError('X', '429', 750);
        return 1;
      },
      policy,
      { sleep: async (ms) => void sleeps.push(ms) },
    );
    expect(sleeps).toEqual([750]);
  });
});

describe('backoffDelay (full jitter)', () => {
  it('stays within [0, min(max, base·2^(n-1))]', () => {
    expect(backoffDelay(1, policy, () => 0)).toBe(0);
    expect(backoffDelay(3, policy, () => 0.999)).toBe(399);
    expect(backoffDelay(10, policy, () => 0.999)).toBe(999); // capped by maxDelayMs
  });
});
