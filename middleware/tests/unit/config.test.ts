import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/shared/config';

// A minimal valid environment. Each test changes one thing to prove one rule.
const base = {
  WEBHOOK_SIGNING_SECRET: 'x'.repeat(32),
  API_TOKENS: 'tok1:ap_maker:alice,tok2:customer:CUST-ACME',
};

describe('loadConfig', () => {
  it('applies safe defaults (mock NetSuite, in-memory storage)', () => {
    const cfg = loadConfig(base);
    expect(cfg.NETSUITE_MODE).toBe('mock');
    expect(cfg.STORAGE_MODE).toBe('memory');
    expect(cfg.PORT).toBe(3000);
  });

  it('parses API tokens into role + subject', () => {
    const cfg = loadConfig(base);
    expect(cfg.API_TOKENS).toEqual([
      { token: 'tok1', role: 'ap_maker', subject: 'alice' },
      { token: 'tok2', role: 'customer', subject: 'CUST-ACME' },
    ]);
  });

  it('rejects a short webhook secret', () => {
    expect(() => loadConfig({ ...base, WEBHOOK_SIGNING_SECRET: 'short' })).toThrow(/at least 16/);
  });

  it('rejects unknown roles in API_TOKENS', () => {
    expect(() => loadConfig({ ...base, API_TOKENS: 't:superuser:x' })).toThrow(/Invalid API_TOKENS/);
  });

  it('requires NetSuite credentials when NETSUITE_MODE=rest', () => {
    expect(() => loadConfig({ ...base, NETSUITE_MODE: 'rest' })).toThrow(/NETSUITE_ACCOUNT_ID/);
  });

  it('does not leak secret values in error messages', () => {
    try {
      loadConfig({ ...base, WEBHOOK_SIGNING_SECRET: 'tiny-secret' });
    } catch (e) {
      expect(String(e)).not.toContain('tiny-secret');
    }
  });
});
