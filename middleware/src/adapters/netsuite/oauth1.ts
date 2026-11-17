/**
 * OAuth 1.0a request signing for NetSuite Token-Based Authentication (TBA).
 *
 * HOW TBA WORKS
 *   An admin creates an *Integration record* (giving a consumer key and secret) and an *Access Token*
 *   for a user and role (giving a token id and secret). Every request is SIGNED with the two secrets.
 *   The secrets themselves never travel over the network: NetSuite recomputes the signature and
 *   compares it. A nonce (random value) plus a timestamp stop an attacker from replaying a captured
 *   request.
 *
 * SIGNATURE (RFC 5849 §3.4, HMAC-SHA256 as NetSuite requires):
 *   1. Collect the oauth_* params and the query-string params, then percent-encode them and sort them.
 *   2. Base string = METHOD & encode(base URL without query) & encode(sorted param string)
 *   3. Key = encode(consumerSecret) & encode(tokenSecret)
 *   4. signature = base64(HMAC-SHA256(key, base string))
 *   5. Header: Authorization: OAuth realm="ACCOUNT_ID", oauth_consumer_key="…", …, oauth_signature="…"
 *
 * TOKEN LIFETIME: TBA tokens do not expire on their own. They are revoked by an admin, or when the
 * role or user changes. NetSuite's OAuth 2.0 option (client-credentials with a certificate) instead
 * issues access tokens that expire after about an hour and must be refreshed. See
 * docs/architecture/netsuite-integration.md.
 */
import { createHmac, randomBytes } from 'node:crypto';

export interface TbaCredentials {
  accountId: string; // e.g. "1234567_SB1" for a sandbox
  consumerKey: string;
  consumerSecret: string;
  tokenId: string;
  tokenSecret: string;
}

/** RFC 3986 percent-encoding. encodeURIComponent leaves !*'() unescaped, but OAuth requires them escaped. */
export function rfc3986(value: string): string {
  return encodeURIComponent(value).replace(
    /[!*'()]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

export interface SignOptions {
  /** Injected in tests to get a deterministic signature. */
  nonce?: string;
  timestamp?: number;
}

export function buildAuthorizationHeader(
  method: string,
  url: string,
  creds: TbaCredentials,
  opts: SignOptions = {},
): string {
  const u = new URL(url);
  const oauth: Record<string, string> = {
    oauth_consumer_key: creds.consumerKey,
    oauth_token: creds.tokenId,
    oauth_signature_method: 'HMAC-SHA256',
    oauth_timestamp: String(opts.timestamp ?? Math.floor(Date.now() / 1000)),
    oauth_nonce: opts.nonce ?? randomBytes(16).toString('hex'),
    oauth_version: '1.0',
  };

  // Query parameters are part of the signature; the body (JSON) is not.
  const pairs: [string, string][] = [...Object.entries(oauth)];
  u.searchParams.forEach((v, k) => pairs.push([k, v]));
  const paramString = pairs
    .map(([k, v]) => [rfc3986(k), rfc3986(v)] as const)
    .sort(([ak, av], [bk, bv]) => (ak === bk ? (av < bv ? -1 : 1) : ak < bk ? -1 : 1))
    .map(([k, v]) => `${k}=${v}`)
    .join('&');

  const baseUrl = `${u.protocol}//${u.host}${u.pathname}`;
  const baseString = [method.toUpperCase(), rfc3986(baseUrl), rfc3986(paramString)].join('&');
  const key = `${rfc3986(creds.consumerSecret)}&${rfc3986(creds.tokenSecret)}`;
  const signature = createHmac('sha256', key).update(baseString).digest('base64');

  const header = { realm: creds.accountId, ...oauth, oauth_signature: signature };
  return (
    'OAuth ' +
    Object.entries(header)
      .map(([k, v]) => `${k}="${k === 'realm' ? v : rfc3986(v)}"`)
      .join(', ')
  );
}

/**
 * NetSuite account IDs appear in hostnames in lowercase with "-" (1234567-sb1.suitetalk.api.netsuite.com),
 * but in the realm in uppercase with "_" (1234567_SB1).
 */
export function accountHost(accountId: string): string {
  return accountId.toLowerCase().replace(/_/g, '-');
}
