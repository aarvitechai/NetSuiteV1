/**
 * ⚠️ DEVELOPMENT-ONLY routes, never mounted when NODE_ENV=production (see app.ts).
 *
 *   GET  /dev/checkout/:sessionId            a SIMULATED hosted checkout page (stands in for the provider's page)
 *   POST /dev/checkout/:sessionId/complete   the "customer" pays with a test token
 *
 * They exist so the portal prototype and the demo can be clicked through end to end on a laptop.
 */
import express, { Router } from 'express';
import { z } from 'zod';
import type { Container } from '../../container';
import { parse } from '../http';

const Session = z.object({ sessionId: z.string().regex(/^cs_[a-z0-9]{20}$/) });

/** Escapes text placed into HTML. WHY: never put untrusted values into HTML unescaped (XSS). */
const esc = (s: string) => s.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);

export function devRoutes(c: Container): Router {
  const r = Router();

  r.get('/dev/checkout/:sessionId', (req, res) => {
    const { sessionId } = parse(Session, req.params);
    const s = c.provider.sessions.get(sessionId);
    if (!s) {
      res.status(404).send('Unknown checkout session');
      return;
    }
    res.type('html')
      .send(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>SimPay test checkout</title><link rel="stylesheet" href="/portal/styles.css"></head><body>
<div class="banner" role="note">SIMULATED HOSTED CHECKOUT (payment provider test page). No real card data is collected.</div>
<main class="card narrow"><h1>Pay ${esc(s.currency)} ${esc(s.amount)}</h1>
<p>Choose a <strong>test token</strong>. A real provider page would collect card details here, on the provider's own domain, never on Northstar's.</p>
<form method="post" action="/dev/checkout/${esc(sessionId)}/complete">
<input type="hidden" name="outcome" value="tok_visa_ok"><button class="primary" type="submit">Pay with test card (success)</button></form>
<form method="post" action="/dev/checkout/${esc(sessionId)}/complete">
<input type="hidden" name="outcome" value="tok_card_declined"><button type="submit">Simulate a declined card</button></form>
</main></body></html>`);
  });

  r.post('/dev/checkout/:sessionId/complete', express.urlencoded({ extended: false }), async (req, res) => {
    const { sessionId } = parse(Session, req.params);
    const { outcome } = parse(z.object({ outcome: z.enum(['tok_visa_ok', 'tok_card_declined']) }), req.body);
    const s = c.provider.sessions.get(sessionId);
    await c.provider.completeCheckout(sessionId, outcome);
    await c.webhooks.drain();
    res.redirect(303, `/portal/?returnFrom=checkout&intent=${encodeURIComponent(s?.intentId ?? '')}`);
  });

  return r;
}
