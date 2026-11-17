/**
 * POST /webhooks/payment-provider
 *
 * No bearer token here: the provider authenticates with the HMAC signature header instead. We read the
 * body as RAW text (express.text), because the signature covers the exact bytes. Parsing to JSON first
 * could change them.
 */
import express, { Router } from 'express';
import type { Container } from '../../container';
import { SIGNATURE_HEADER } from '../../adapters/payment-provider/webhook-signature';

export function webhookRoutes(c: Container): Router {
  const r = Router();
  r.post(
    '/webhooks/payment-provider',
    express.text({ type: 'application/json', limit: '64kb' }),
    async (req, res) => {
      const raw = typeof req.body === 'string' ? req.body : '';
      const result = await c.webhooks.receive(raw, req.header(SIGNATURE_HEADER));
      // 202 Accepted = "received and stored, processing later". Duplicates get 200 (already handled).
      res.status(result.status === 'accepted' ? 202 : 200).json(result);
    },
  );
  return r;
}
