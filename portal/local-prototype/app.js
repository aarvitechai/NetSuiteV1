/**
 * Customer portal prototype: plain browser JavaScript, no framework, so every line is readable.
 *
 * SECURITY NOTES
 *  - All text from the server is inserted with textContent, never innerHTML, so a malicious invoice memo
 *    cannot inject script (XSS).
 *  - The token is kept in sessionStorage (cleared when the tab closes). A real SCMA site uses NetSuite's
 *    session cookie instead.
 *  - The browser never decides WHAT the customer may see. The server only returns the signed-in
 *    customer's data.
 */
(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const state = { token: sessionStorage.getItem('nsd-token') || '', statement: null };

  /** Calls the middleware API with the bearer token and returns parsed JSON (throws on HTTP errors). */
  async function api(path, options) {
    const res = await fetch(`/api/v1${path}`, {
      ...options,
      headers: {
        Authorization: `Bearer ${state.token}`,
        'Content-Type': 'application/json',
        ...(options && options.headers),
      },
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error((body.error && body.error.message) || `HTTP ${res.status}`);
      err.status = res.status;
      err.correlationId = body.error && body.error.correlationId;
      throw err;
    }
    return body;
  }

  function setStatus(message, kind) {
    const el = $('status');
    el.textContent = message || '';
    el.className = `status ${kind || ''}`;
  }

  /** Builds a table cell safely (textContent = no HTML injection). */
  function cell(text, className) {
    const td = document.createElement('td');
    td.textContent = text;
    if (className) td.className = className;
    return td;
  }

  const money = (amount, currency) =>
    `${currency} ${Number(amount).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

  const INVOICE_STATE_LABEL = {
    open: 'Open',
    overdue: 'Overdue',
    payment_pending: 'Payment pending',
    disputed: 'Under review',
  };

  function renderStatement(s) {
    $('balance').textContent = s.openBalance.length
      ? s.openBalance.map((b) => money(b.amount, b.currency)).join(' · ')
      : money('0', 'USD');

    const rows = $('invoice-rows');
    rows.replaceChildren();
    $('invoices-empty').hidden = s.invoices.length > 0;
    for (const inv of s.invoices) {
      const tr = document.createElement('tr');
      const tdBox = document.createElement('td');
      const box = document.createElement('input');
      box.type = 'checkbox';
      box.value = inv.externalId;
      box.dataset.amount = inv.amountDue;
      box.dataset.currency = inv.currency;
      box.id = `inv-${inv.externalId}`;
      // You cannot select an invoice that already has a payment in flight (prevents double payment).
      box.disabled = inv.state === 'payment_pending';
      box.setAttribute('aria-label', `Select invoice ${inv.number}`);
      tdBox.appendChild(box);
      tr.appendChild(tdBox);
      tr.appendChild(cell(inv.number));
      tr.appendChild(cell(inv.dueDate));
      tr.appendChild(cell(money(inv.amountDue, inv.currency), 'num'));
      const label =
        INVOICE_STATE_LABEL[inv.state] + (inv.state === 'overdue' ? ` (${inv.daysOverdue} days)` : '');
      tr.appendChild(cell(label, `badge ${inv.state}`));
      rows.appendChild(tr);
    }

    const prow = $('payment-rows');
    prow.replaceChildren();
    $('payments-empty').hidden = s.payments.length > 0;
    for (const p of s.payments) {
      const tr = document.createElement('tr');
      tr.appendChild(cell(new Date(p.createdAt).toLocaleDateString()));
      tr.appendChild(cell(p.invoices.join(', ')));
      tr.appendChild(cell(money(p.amount, p.currency), 'num'));
      tr.appendChild(cell(p.status, `badge ${p.status.split(' ')[0].toLowerCase()}`));
      prow.appendChild(tr);
    }
    updateSelection();
  }

  function selected() {
    return [...document.querySelectorAll('#invoice-rows input[type=checkbox]:checked')];
  }

  function updateSelection() {
    const boxes = selected();
    $('pay-btn').disabled = boxes.length === 0;
    if (!boxes.length) {
      $('selected-total').textContent = '';
      return;
    }
    // Display only. The SERVER recomputes the amount from NetSuite and never trusts this number.
    const cents = boxes.reduce((s, b) => s + Math.round(Number(b.dataset.amount) * 100), 0);
    $('selected-total').textContent = `Selected: ${money(cents / 100, boxes[0].dataset.currency)}`;
  }

  async function load() {
    setStatus('Loading your account…', 'loading');
    try {
      const me = await api('/portal/me');
      $('who').textContent = me.companyName;
      state.statement = await api('/portal/statement');
      renderStatement(state.statement);
      const params = new URLSearchParams(location.search);
      if (params.get('returnFrom') === 'checkout') {
        const p = state.statement.payments.find((x) => x.id === params.get('intent'));
        setStatus(
          p ? `Payment status: ${p.status}` : 'Returned from checkout.',
          p && p.status === 'Failed' ? 'error' : 'ok',
        );
        history.replaceState(null, '', location.pathname);
      } else setStatus('');
    } catch (e) {
      if (e.status === 401 || e.status === 403)
        return logout('Your session is not valid. Please sign in again.');
      setStatus(
        `Could not load your account (${e.message}). Reference: ${e.correlationId || 'n/a'}`,
        'error',
      );
    }
  }

  async function pay(event) {
    event.preventDefault();
    const ids = selected().map((b) => b.value);
    $('pay-btn').disabled = true;
    setStatus('Preparing secure checkout…', 'loading');
    try {
      // A new idempotency key per click: a double-click cannot create two payments.
      const key = `portal-${crypto.randomUUID()}`;
      const intent = await api('/payment-intents', {
        method: 'POST',
        headers: { 'Idempotency-Key': key },
        body: JSON.stringify({ invoiceExternalIds: ids }),
      });
      // Prototype: go to the SIMULATED hosted checkout. In production: location.href = intent.checkoutUrl.
      location.href = `/dev/checkout/${encodeURIComponent(intent.providerRef)}`;
    } catch (e) {
      setStatus(`Payment could not be started: ${e.message}`, 'error');
      updateSelection();
    }
  }

  function show(signedIn) {
    $('login').hidden = signedIn;
    $('account').hidden = !signedIn;
    $('logout').hidden = !signedIn;
  }

  function logout(message) {
    sessionStorage.removeItem('nsd-token');
    state.token = '';
    $('who').textContent = '';
    show(false);
    if (message) setStatus(message, 'error');
    $('token').focus();
  }

  document.addEventListener('DOMContentLoaded', () => {
    $('login-form').addEventListener('submit', (e) => {
      e.preventDefault();
      state.token = $('token').value.trim();
      sessionStorage.setItem('nsd-token', state.token);
      show(true);
      load();
    });
    $('logout').addEventListener('click', () => logout());
    $('invoice-rows').addEventListener('change', updateSelection);
    $('pay-form').addEventListener('submit', pay);
    if (state.token) {
      show(true);
      load();
    } else show(false);
  });
})();
