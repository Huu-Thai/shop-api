import { Injectable } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import {
  authFailures,
  orderOutcomes,
  ordersPlaced,
  orderValue,
  paymentWebhooks,
  payments,
} from './metrics.js';

type Evt = {
  name: string;
  data?: Record<string, unknown>;
  audit?: { changes?: Record<string, unknown> };
};

const ORDER_EVENTS = new Set([
  'order.paid',
  'order.canceled',
  'order.shipped',
  'order.refunded',
  'order.completed',
]);
const PAYMENT_OUTCOMES: Record<string, string> = {
  'payment.captured': 'captured',
  'payment.failed': 'failed',
  'payment.canceled': 'canceled',
  'payment.refunded': 'refunded',
  'payment.refund-failed': 'refund-failed',
};

/**
 * Business counters from committed events (orders, payments, sign-in failures). The outbox may
 * deliver an event twice after a crash, so these are close to, not exactly, the true counts —
 * reports come from the database, dashboards and alerts from here.
 */
@Injectable()
export class BusinessMetricsListener {
  @OnEvent('**')
  observe(e: Evt): void {
    if (!e?.name) return;
    if (e.name === 'order.placed') {
      const currency = String(e.audit?.changes?.currency ?? 'unknown');
      ordersPlaced.inc({ currency });
      const total = Number(e.audit?.changes?.grandTotal ?? 0);
      if (total > 0) orderValue.inc({ currency }, total);
      return;
    }
    if (ORDER_EVENTS.has(e.name)) {
      orderOutcomes.inc({ event: e.name.slice('order.'.length) });
      return;
    }
    const outcome = PAYMENT_OUTCOMES[e.name];
    if (outcome) {
      payments.inc({
        provider: String(e.data?.provider ?? 'unknown'),
        outcome,
      });
      return;
    }
    if (e.name === 'payment.webhook-received') {
      paymentWebhooks.inc({ result: String(e.data?.reason ?? 'unknown') });
      return;
    }
    if (e.name === 'auth.login-failed') authFailures.inc({ realm: 'admin' });
    else if (e.name === 'customer.login-failed')
      authFailures.inc({ realm: 'customer' });
  }
}
