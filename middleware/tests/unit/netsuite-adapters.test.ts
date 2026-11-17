import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  classifyNetSuiteResponse,
  classifyNetworkError,
  NetSuiteAuthError,
  NetSuiteBusinessError,
  parseRetryAfter,
} from '../../src/adapters/netsuite/errors';
import { MockNetSuiteAdapter } from '../../src/adapters/netsuite/mock-netsuite';
import { accountHost, buildAuthorizationHeader, rfc3986 } from '../../src/adapters/netsuite/oauth1';
import { NetSuiteRestAdapter, type FetchFn } from '../../src/adapters/netsuite/rest-netsuite';
import {
  buildVendorUpsertEnvelope,
  tokenPassportSignature,
  xmlEscape,
} from '../../src/adapters/netsuite/soap-envelope';
import { TransientError } from '../../src/shared/errors';

const creds = {
  accountId: '1234567_SB1',
  consumerKey: 'ck',
  consumerSecret: 'cs',
  tokenId: 'tk',
  tokenSecret: 'ts',
};

describe('OAuth 1.0a (TBA) signer', () => {
  it('percent-encodes per RFC 3986', () => {
    expect(rfc3986("a b!*'()")).toBe('a%20b%21%2A%27%28%29');
  });

  it('produces a signature that matches an independent recomputation', () => {
    const url =
      'https://1234567-sb1.suitetalk.api.netsuite.com/services/rest/query/v1/suiteql?limit=10&offset=0';
    const header = buildAuthorizationHeader('POST', url, creds, { nonce: 'abc', timestamp: 1700000000 });
    expect(header).toMatch(/^OAuth realm="1234567_SB1", oauth_consumer_key="ck"/);

    // Recompute by hand, following the spec step by step.
    const params =
      'limit=10&oauth_consumer_key=ck&oauth_nonce=abc&oauth_signature_method=HMAC-SHA256&oauth_timestamp=1700000000&oauth_token=tk&oauth_version=1.0&offset=0';
    const base = `POST&${rfc3986('https://1234567-sb1.suitetalk.api.netsuite.com/services/rest/query/v1/suiteql')}&${rfc3986(params)}`;
    const expected = createHmac('sha256', 'cs&ts').update(base).digest('base64');
    expect(header).toContain(`oauth_signature="${rfc3986(expected)}"`);
  });

  it('uses a fresh nonce each time (replay protection)', () => {
    const url = 'https://x.suitetalk.api.netsuite.com/services/rest/record/v1/vendor';
    expect(buildAuthorizationHeader('GET', url, creds)).not.toBe(buildAuthorizationHeader('GET', url, creds));
  });

  it('derives the hostname from the account ID', () => {
    expect(accountHost('1234567_SB1')).toBe('1234567-sb1');
  });
});

describe('NetSuite error classification', () => {
  it('treats 429 and 5xx as transient, 400 as business, 401 as auth', () => {
    expect(classifyNetSuiteResponse(429, {}, '2')).toMatchObject({
      code: 'NETSUITE_RATE_LIMITED',
      transient: true,
      retryAfterMs: 2000,
    });
    expect(classifyNetSuiteResponse(503, {})).toBeInstanceOf(TransientError);
    const biz = classifyNetSuiteResponse(400, {
      'o:errorDetails': [{ detail: 'Period is closed', 'o:errorCode': 'INVALID_VALUE' }],
    });
    expect(biz).toBeInstanceOf(NetSuiteBusinessError);
    expect(biz.message).toBe('Period is closed');
    expect(classifyNetSuiteResponse(401, {})).toBeInstanceOf(NetSuiteAuthError);
  });

  it('treats concurrency limit as transient even with status 400', () => {
    expect(
      classifyNetSuiteResponse(400, { 'o:errorDetails': [{ 'o:errorCode': 'CONCURRENCY_LIMIT_EXCEEDED' }] })
        .transient,
    ).toBe(true);
  });

  it('treats network errors and timeouts as transient', () => {
    expect(classifyNetworkError(Object.assign(new Error('t'), { name: 'TimeoutError' })).code).toBe(
      'NETSUITE_TIMEOUT',
    );
    expect(classifyNetworkError(new Error('ECONNRESET')).transient).toBe(true);
  });

  it('parses Retry-After seconds and dates', () => {
    expect(parseRetryAfter('5')).toBe(5000);
    expect(parseRetryAfter(new Date(10_000).toUTCString(), 4_000)).toBe(6000);
    expect(parseRetryAfter(undefined)).toBeUndefined();
  });
});

describe('NetSuiteRestAdapter (against a fake fetch)', () => {
  function fakeFetch(responses: { status: number; body?: unknown; headers?: Record<string, string> }[]) {
    const calls: { url: string; init: RequestInit }[] = [];
    const fn: FetchFn = async (url, init) => {
      calls.push({ url, init });
      const r = responses.shift() ?? { status: 200, body: { items: [], hasMore: false } };
      return new Response(r.body === undefined ? null : JSON.stringify(r.body), {
        status: r.status,
        headers: r.headers,
      });
    };
    return { fn, calls };
  }

  it('pages through SuiteQL results', async () => {
    const f = fakeFetch([
      { status: 200, body: { items: [{ id: 1 }], hasMore: true } },
      { status: 200, body: { items: [{ id: 2 }], hasMore: false } },
    ]);
    const a = new NetSuiteRestAdapter(creds, f.fn);
    expect(await a.suiteql('SELECT id FROM vendor')).toEqual([{ id: 1 }, { id: 2 }]);
    expect(f.calls[1]!.url).toContain('offset=1000');
    expect((f.calls[0]!.init.headers as Record<string, string>).Prefer).toBe('transient');
  });

  it('createVendorPayment returns the existing record when the externalId is already known', async () => {
    const f = fakeFetch([{ status: 200, body: { items: [{ id: '555' }], hasMore: false } }]);
    const a = new NetSuiteRestAdapter(creds, f.fn);
    const r = await a.createVendorPayment({
      externalId: 'PI-1',
      vendorExternalId: 'V',
      currency: 'USD',
      tranDate: '2026-11-20',
      applications: [],
      batchRef: 'PB',
    });
    expect(r).toEqual({ internalId: '555', externalId: 'PI-1', created: false });
    expect(f.calls).toHaveLength(1); // no POST was sent
  });

  it('upserts vendors with PUT eid:', async () => {
    const f = fakeFetch([
      { status: 200, body: { items: [], hasMore: false } }, // lookup before
      { status: 204 }, // PUT
      { status: 200, body: { items: [{ id: '77' }], hasMore: false } }, // lookup after
    ]);
    const a = new NetSuiteRestAdapter(creds, f.fn);
    const r = await a.upsertVendor({
      externalId: 'VEND-X',
      companyName: 'X',
      currency: 'USD',
      isInactive: false,
      paymentRail: 'ACH',
      bankToken: 't',
    });
    expect(f.calls[1]!.url).toContain('/record/v1/vendor/eid:VEND-X');
    expect(f.calls[1]!.init.method).toBe('PUT');
    expect(r).toEqual({ internalId: '77', externalId: 'VEND-X', created: true });
  });

  it('surfaces 429 as a transient error', async () => {
    const f = fakeFetch([{ status: 429, body: {}, headers: { 'retry-after': '1' } }]);
    await expect(new NetSuiteRestAdapter(creds, f.fn).ping()).rejects.toMatchObject({
      code: 'NETSUITE_RATE_LIMITED',
    });
  });
});

describe('SOAP envelope (reference)', () => {
  it('escapes XML and signs the token passport', () => {
    expect(xmlEscape('<a&b>')).toBe('&lt;a&amp;b&gt;');
    const xml = buildVendorUpsertEnvelope(
      creds,
      { externalId: 'V&1', companyName: 'A <B>' },
      { version: '2024_2', nonce: 'n', timestamp: 1 },
    );
    expect(xml).toContain('externalId="V&amp;1"');
    expect(xml).toContain('A &lt;B&gt;');
    expect(xml).toContain(tokenPassportSignature(creds, 'n', 1));
  });
});

describe('MockNetSuiteAdapter', () => {
  it('creates a vendor payment once per externalId and reduces the bill balance', async () => {
    const ns = new MockNetSuiteAdapter();
    const input = {
      externalId: 'PI-1',
      vendorExternalId: 'VEND-ACMESUP',
      currency: 'USD',
      tranDate: '2026-11-20',
      applications: [{ docExternalId: 'BILL-1001', amount: '1250.00' }],
      batchRef: 'PB-1',
    };
    expect((await ns.createVendorPayment(input)).created).toBe(true);
    expect((await ns.createVendorPayment(input)).created).toBe(false);
    expect(ns.countTransactions('VendPymt')).toBe(1);
    expect((await ns.getVendorBill('BILL-1001'))!.amountRemaining).toBe('0.00');
  });

  it('rejects overpayment and postings into a closed period', async () => {
    const ns = new MockNetSuiteAdapter();
    await expect(
      ns.createVendorPayment({
        externalId: 'X',
        vendorExternalId: 'V',
        currency: 'USD',
        tranDate: '2026-11-20',
        applications: [{ docExternalId: 'BILL-1002', amount: '9999.00' }],
        batchRef: 'B',
      }),
    ).rejects.toThrow(/exceeds/);
    ns.closedPeriods.add('2026-10');
    await expect(
      ns.createVendorPayment({
        externalId: 'Y',
        vendorExternalId: 'V',
        currency: 'USD',
        tranDate: '2026-10-31',
        applications: [],
        batchRef: 'B',
      }),
    ).rejects.toThrow(/closed/);
  });

  it('voids idempotently and restores the balance', async () => {
    const ns = new MockNetSuiteAdapter();
    await ns.createVendorPayment({
      externalId: 'P',
      vendorExternalId: 'V',
      currency: 'USD',
      tranDate: '2026-11-20',
      applications: [{ docExternalId: 'BILL-1002', amount: '480.50' }],
      batchRef: 'B',
    });
    await ns.voidVendorPayment('P', 'R01');
    await ns.voidVendorPayment('P', 'R01');
    expect((await ns.getVendorBill('BILL-1002'))!.amountRemaining).toBe('480.50');
  });

  it('injects faults a fixed number of times', async () => {
    const ns = new MockNetSuiteAdapter();
    ns.injectFault('unavailable', 2, 'listVendors');
    await expect(ns.listVendors()).rejects.toBeInstanceOf(TransientError);
    await expect(ns.listVendors()).rejects.toBeInstanceOf(TransientError);
    await expect(ns.listVendors()).resolves.toHaveLength(5);
  });
});
