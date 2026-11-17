/**
 * SuiteTalk SOAP: envelope builder with a TBA TokenPassport.
 *
 * ⚠️ DESIGN / REFERENCE ONLY. The platform uses REST for every operation. SOAP is included because
 * many existing NetSuite integrations still use it, and a senior developer must be able to read and
 * produce it. Typical reasons to still use SOAP:
 *   - operations or records not (yet) exposed in REST in a given account version;
 *   - large existing integrations built on SOAP.
 * Oracle has announced the gradual retirement of SOAP endpoints in favour of REST. Check the
 * current deprecation schedule before building anything new on SOAP.
 *
 * TOKEN PASSPORT: SOAP TBA does not use an HTTP Authorization header. A <tokenPassport> goes in the SOAP
 * header, signed with HMAC-SHA256 over: account & consumerKey & tokenId & nonce & timestamp.
 */
import { createHmac, randomBytes } from 'node:crypto';
import type { TbaCredentials } from './oauth1';

/** Escapes text for XML element content and attributes. WHY: unescaped "<" or "&" would break or inject XML. */
export function xmlEscape(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

export function tokenPassportSignature(creds: TbaCredentials, nonce: string, timestamp: number): string {
  const base = [creds.accountId, creds.consumerKey, creds.tokenId, nonce, String(timestamp)].join('&');
  return createHmac('sha256', `${creds.consumerSecret}&${creds.tokenSecret}`).update(base).digest('base64');
}

export interface SoapOptions {
  /** WSDL version, e.g. "2024_2". Must match the endpoint URL you call. */
  version: string;
  nonce?: string;
  timestamp?: number;
}

/** Builds an `upsert` envelope for a Vendor addressed by externalId. */
export function buildVendorUpsertEnvelope(
  creds: TbaCredentials,
  vendor: { externalId: string; companyName: string },
  opts: SoapOptions,
): string {
  const nonce = opts.nonce ?? randomBytes(10).toString('hex');
  const ts = opts.timestamp ?? Math.floor(Date.now() / 1000);
  const v = opts.version;
  return `<?xml version="1.0" encoding="UTF-8"?>
<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"
  xmlns:platformMsgs="urn:messages_${v}.platform.webservices.netsuite.com"
  xmlns:platformCore="urn:core_${v}.platform.webservices.netsuite.com"
  xmlns:listRel="urn:relationships_${v}.lists.webservices.netsuite.com">
  <soap:Header>
    <platformMsgs:tokenPassport>
      <platformCore:account>${xmlEscape(creds.accountId)}</platformCore:account>
      <platformCore:consumerKey>${xmlEscape(creds.consumerKey)}</platformCore:consumerKey>
      <platformCore:token>${xmlEscape(creds.tokenId)}</platformCore:token>
      <platformCore:nonce>${xmlEscape(nonce)}</platformCore:nonce>
      <platformCore:timestamp>${ts}</platformCore:timestamp>
      <platformCore:signature algorithm="HMAC_SHA256">${tokenPassportSignature(creds, nonce, ts)}</platformCore:signature>
    </platformMsgs:tokenPassport>
  </soap:Header>
  <soap:Body>
    <platformMsgs:upsert>
      <platformMsgs:record xsi:type="listRel:Vendor" externalId="${xmlEscape(vendor.externalId)}"
        xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
        <listRel:companyName>${xmlEscape(vendor.companyName)}</listRel:companyName>
      </platformMsgs:record>
    </platformMsgs:upsert>
  </soap:Body>
</soap:Envelope>`;
}
