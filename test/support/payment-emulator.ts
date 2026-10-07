/**
 * Local emulator of the payment providers' sandbox APIs (Stripe, PayPal, VNPay, MoMo) for e2e tests.
 * It checks what the shop sends exactly as the providers do (API keys, OAuth, HMAC signatures over
 * the documented fields) and produces correctly signed notifications, so the adapters' protocols are
 * exercised end to end without network access or sandbox accounts.
 */
import { createHmac, randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

export const CREDS = {
  stripe: {
    secretKey: 'sk_test_emulator',
    publishableKey: 'pk_test_emulator',
    webhookSecret: 'whsec_emulator',
  },
  paypal: {
    clientId: 'pp-client',
    clientSecret: 'pp-secret',
    webhookId: 'WH-EMULATOR',
  },
  vnpay: { tmnCode: 'EMUTMN01', hashSecret: 'VNPAYEMULATORSECRET' },
  momo: {
    partnerCode: 'MOMOEMU',
    accessKey: 'momo-access',
    secretKey: 'momo-secret',
  },
};

const hmac = (alg: string, key: string, data: string) =>
  createHmac(alg, key).update(data, 'utf8').digest('hex');
const vnpQuery = (p: Record<string, string>) =>
  Object.keys(p)
    .sort()
    .map(
      (k) =>
        `${encodeURIComponent(k)}=${encodeURIComponent(p[k]).replace(/%20/g, '+')}`,
    )
    .join('&');
const momoSig = (f: Record<string, unknown>, keys: string[]) =>
  hmac(
    'sha256',
    CREDS.momo.secretKey,
    keys.map((k) => `${k}=${f[k] ?? ''}`).join('&'),
  );

interface Intent {
  id: string;
  amount: number;
  currency: string;
  status: string;
  client_secret: string;
  latest_charge: string | null;
  metadata: Record<string, string>;
}

export class PaymentEmulator {
  private server?: Server;
  base = '';
  /** Requests whose credentials or signatures were wrong (should stay empty). */
  readonly rejected: string[] = [];
  readonly calls: string[] = [];
  readonly stripeIntents = new Map<string, Intent>();
  readonly paypalOrders = new Map<
    string,
    {
      id: string;
      status: string;
      amount: string;
      currency: string;
      captureId?: string;
    }
  >();
  readonly vnpayRefunds: Record<string, string>[] = [];
  readonly momoOrders = new Map<
    string,
    { amount: number; transId: number; paid: boolean }
  >();
  readonly refunds: { provider: string; amount: string }[] = [];
  /** When set, PayPal answers refunds as PENDING until `completePaypalRefunds()`. */
  paypalRefundsPending = false;
  readonly paypalRefunds = new Map<string, string>();

  async start(): Promise<void> {
    this.server = createServer((req, res) => {
      let data = '';
      req.on('data', (c) => (data += c));
      req.on('end', () => {
        const out = this.route(req, data);
        res.writeHead(out.status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(out.body));
      });
    });
    await new Promise<void>((r) => this.server!.listen(0, '127.0.0.1', r));
    this.base = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  async stop(): Promise<void> {
    await new Promise<void>((r) => this.server?.close(() => r()));
  }

  completePaypalRefunds(): void {
    for (const id of this.paypalRefunds.keys())
      this.paypalRefunds.set(id, 'COMPLETED');
  }

  private reject(why: string) {
    this.rejected.push(why);
    return { status: 401, body: { error: { message: why } } };
  }

  private route(
    req: IncomingMessage,
    raw: string,
  ): { status: number; body: unknown } {
    const url = new URL(req.url ?? '/', 'http://x');
    const path = url.pathname;
    this.calls.push(`${req.method} ${path}`);
    const auth = req.headers.authorization ?? '';

    // ── Stripe (form bodies, bearer secret key, Idempotency-Key)
    if (path.startsWith('/stripe/')) {
      if (auth !== `Bearer ${CREDS.stripe.secretKey}`)
        return this.reject('stripe: bad key');
      const form = Object.fromEntries(new URLSearchParams(raw));
      if (path === '/stripe/v1/payment_intents' && req.method === 'POST') {
        if (!req.headers['idempotency-key'])
          return this.reject('stripe: no idempotency key');
        const id = `pi_${randomUUID().replace(/-/g, '').slice(0, 20)}`;
        const intent: Intent = {
          id,
          amount: Number(form.amount),
          currency: form.currency,
          status: 'requires_payment_method',
          client_secret: `${id}_secret_x`,
          latest_charge: null,
          metadata: {
            order_id: form['metadata[order_id]'],
            payment_id: form['metadata[payment_id]'],
          },
        };
        this.stripeIntents.set(id, intent);
        return { status: 200, body: intent };
      }
      const m = /^\/stripe\/v1\/payment_intents\/([^/]+)(\/cancel)?$/.exec(
        path,
      );
      if (m) {
        const intent = this.stripeIntents.get(m[1]);
        if (!intent)
          return {
            status: 404,
            body: { error: { message: 'No such intent' } },
          };
        if (m[2]) intent.status = 'canceled';
        return { status: 200, body: intent };
      }
      if (path === '/stripe/v1/refunds') {
        const intent = this.stripeIntents.get(form.payment_intent);
        if (!intent || intent.status !== 'succeeded')
          return {
            status: 400,
            body: { error: { message: 'Not refundable' } },
          };
        this.refunds.push({ provider: 'stripe', amount: form.amount });
        return {
          status: 200,
          body: { id: `re_${randomUUID().slice(0, 8)}`, status: 'succeeded' },
        };
      }
    }

    // ── PayPal (OAuth client credentials, then bearer; PayPal-Request-Id idempotency)
    if (path.startsWith('/paypal/')) {
      if (path === '/paypal/v1/oauth2/token') {
        const expected = `Basic ${Buffer.from(`${CREDS.paypal.clientId}:${CREDS.paypal.clientSecret}`).toString('base64')}`;
        if (auth !== expected)
          return this.reject('paypal: bad client credentials');
        return {
          status: 200,
          body: { access_token: 'pp-access-token', expires_in: 3600 },
        };
      }
      if (auth !== 'Bearer pp-access-token')
        return this.reject('paypal: bad access token');
      const body = raw ? JSON.parse(raw) : {};
      if (path === '/paypal/v2/checkout/orders' && req.method === 'POST') {
        const id = `PPORDER${randomUUID().slice(0, 8).toUpperCase()}`;
        const unit = body.purchase_units[0];
        this.paypalOrders.set(id, {
          id,
          status: 'CREATED',
          amount: unit.amount.value,
          currency: unit.amount.currency_code,
        });
        return {
          status: 201,
          body: {
            id,
            status: 'PAYER_ACTION_REQUIRED',
            links: [
              {
                rel: 'payer-action',
                href: `https://www.sandbox.paypal.com/checkoutnow?token=${id}`,
              },
            ],
          },
        };
      }
      const cap = /^\/paypal\/v2\/checkout\/orders\/([^/]+)\/capture$/.exec(
        path,
      );
      if (cap) {
        const o = this.paypalOrders.get(cap[1]);
        if (!o) return { status: 404, body: {} };
        if (o.status === 'COMPLETED')
          return {
            status: 422,
            body: { details: [{ issue: 'ORDER_ALREADY_CAPTURED' }] },
          };
        if (o.status !== 'APPROVED')
          return {
            status: 422,
            body: { details: [{ issue: 'ORDER_NOT_APPROVED' }] },
          };
        o.status = 'COMPLETED';
        o.captureId = `CAP${randomUUID().slice(0, 8).toUpperCase()}`;
        return { status: 201, body: this.paypalView(o) };
      }
      const get = /^\/paypal\/v2\/checkout\/orders\/([^/]+)$/.exec(path);
      if (get) {
        const o = this.paypalOrders.get(get[1]);
        return o
          ? { status: 200, body: this.paypalView(o) }
          : { status: 404, body: {} };
      }
      if (/^\/paypal\/v2\/payments\/captures\/[^/]+\/refund$/.test(path)) {
        this.refunds.push({ provider: 'paypal', amount: body.amount.value });
        const refund = {
          id: `REF${randomUUID().slice(0, 6)}`,
          status: this.paypalRefundsPending ? 'PENDING' : 'COMPLETED',
        };
        this.paypalRefunds.set(refund.id, refund.status);
        return { status: 201, body: refund };
      }
      const ppRefund = /^\/paypal\/v2\/payments\/refunds\/([^/]+)$/.exec(path);
      if (ppRefund && req.method === 'GET') {
        const status = this.paypalRefunds.get(ppRefund[1]);
        return status
          ? { status: 200, body: { id: ppRefund[1], status } }
          : { status: 404, body: {} };
      }
      if (path === '/paypal/v1/notifications/verify-webhook-signature')
        return {
          status: 200,
          body: {
            verification_status:
              body.transmission_sig === 'valid-signature' &&
              body.webhook_id === CREDS.paypal.webhookId
                ? 'SUCCESS'
                : 'FAILURE',
          },
        };
    }

    // ── VNPay merchant API (pipe-joined HMAC-SHA512 checksums)
    if (path === '/vnpay/merchant_webapi/api/transaction') {
      const b = JSON.parse(raw) as Record<string, string>;
      const fields =
        b.vnp_Command === 'refund'
          ? [
              'vnp_RequestId',
              'vnp_Version',
              'vnp_Command',
              'vnp_TmnCode',
              'vnp_TransactionType',
              'vnp_TxnRef',
              'vnp_Amount',
              'vnp_TransactionNo',
              'vnp_TransactionDate',
              'vnp_CreateBy',
              'vnp_CreateDate',
              'vnp_IpAddr',
              'vnp_OrderInfo',
            ]
          : [
              'vnp_RequestId',
              'vnp_Version',
              'vnp_Command',
              'vnp_TmnCode',
              'vnp_TxnRef',
              'vnp_TransactionDate',
              'vnp_CreateDate',
              'vnp_IpAddr',
              'vnp_OrderInfo',
            ];
      if (
        b.vnp_SecureHash !==
        hmac(
          'sha512',
          CREDS.vnpay.hashSecret,
          fields.map((k) => b[k]).join('|'),
        )
      )
        return this.reject('vnpay: bad checksum');
      if (b.vnp_Command === 'refund') {
        this.vnpayRefunds.push(b);
        this.refunds.push({
          provider: 'vnpay',
          amount: String(Number(b.vnp_Amount) / 100),
        });
        return {
          status: 200,
          body: {
            vnp_ResponseCode: '00',
            vnp_TransactionNo: `R${b.vnp_TransactionNo}`,
          },
        };
      }
      return {
        status: 200,
        body: { vnp_ResponseCode: '00', vnp_TransactionStatus: '01' },
      };
    }

    // ── MoMo (HMAC-SHA256 over documented key order)
    if (path.startsWith('/momo/')) {
      const b = JSON.parse(raw) as Record<string, string | number>;
      const f = { ...b, accessKey: CREDS.momo.accessKey };
      if (path === '/momo/v2/gateway/api/create') {
        if (
          b.signature !==
          momoSig(f, [
            'accessKey',
            'amount',
            'extraData',
            'ipnUrl',
            'orderId',
            'orderInfo',
            'partnerCode',
            'redirectUrl',
            'requestId',
            'requestType',
          ])
        )
          return this.reject('momo: bad create signature');
        this.momoOrders.set(String(b.orderId), {
          amount: Number(b.amount),
          transId: Math.floor(Math.random() * 1e9),
          paid: false,
        });
        return {
          status: 200,
          body: {
            resultCode: 0,
            message: 'Success',
            payUrl: `https://test-payment.momo.vn/pay?o=${b.orderId}`,
            deeplink: 'momo://pay',
            qrCodeUrl: 'https://qr',
          },
        };
      }
      if (path === '/momo/v2/gateway/api/refund') {
        if (
          b.signature !==
          momoSig(f, [
            'accessKey',
            'amount',
            'description',
            'orderId',
            'partnerCode',
            'requestId',
            'transId',
          ])
        )
          return this.reject('momo: bad refund signature');
        this.refunds.push({ provider: 'momo', amount: String(b.amount) });
        return {
          status: 200,
          body: { resultCode: 0, message: 'Success', transId: 777 },
        };
      }
      if (path === '/momo/v2/gateway/api/query') {
        if (
          b.signature !==
          momoSig(f, ['accessKey', 'orderId', 'partnerCode', 'requestId'])
        )
          return this.reject('momo: bad query signature');
        return {
          status: 200,
          body: { orderId: b.orderId, resultCode: 1000, message: 'Pending' },
        };
      }
    }
    return {
      status: 404,
      body: { error: { message: `emulator: no route ${path}` } },
    };
  }

  private paypalView(o: {
    id: string;
    status: string;
    amount: string;
    currency: string;
    captureId?: string;
  }) {
    return {
      id: o.id,
      status: o.status,
      purchase_units: [
        {
          payments: o.captureId
            ? {
                captures: [
                  {
                    id: o.captureId,
                    status: 'COMPLETED',
                    amount: { value: o.amount, currency_code: o.currency },
                  },
                ],
              }
            : {},
        },
      ],
    };
  }

  // ── What the shopper / provider does, as the test drives it ──

  /** Stripe: the card was confirmed with Stripe.js; returns the signed webhook to deliver. */
  stripeSucceed(intentId: string): {
    body: string;
    headers: Record<string, string>;
  } {
    const intent = this.stripeIntents.get(intentId)!;
    intent.status = 'succeeded';
    intent.latest_charge = `ch_${intentId.slice(3)}`;
    const body = JSON.stringify({
      id: `evt_${randomUUID().replace(/-/g, '').slice(0, 16)}`,
      type: 'payment_intent.succeeded',
      data: { object: { ...intent, amount_received: intent.amount } },
    });
    const t = Math.floor(Date.now() / 1000);
    return {
      body,
      headers: {
        'stripe-signature': `t=${t},v1=${hmac('sha256', CREDS.stripe.webhookSecret, `${t}.${body}`)}`,
        'content-type': 'application/json',
      },
    };
  }

  /** PayPal: the buyer approved on PayPal; returns the return-URL parameters. */
  paypalApprove(orderId: string): Record<string, string> {
    this.paypalOrders.get(orderId)!.status = 'APPROVED';
    return { token: orderId, PayerID: 'PAYER123' };
  }

  /** VNPay: verifies our signed pay URL as VNPay does, then returns the signed IPN parameters. */
  vnpayResult(payUrl: string, success = true): Record<string, string> {
    const u = new URL(payUrl);
    const params = Object.fromEntries(u.searchParams.entries());
    const { vnp_SecureHash, ...rest } = params;
    if (
      vnp_SecureHash !== hmac('sha512', CREDS.vnpay.hashSecret, vnpQuery(rest))
    ) {
      this.rejected.push('vnpay: bad pay URL signature');
      throw new Error('VNPay emulator: the pay URL is not signed correctly');
    }
    const result: Record<string, string> = {
      vnp_Amount: rest.vnp_Amount,
      vnp_BankCode: 'NCB',
      vnp_OrderInfo: rest.vnp_OrderInfo,
      vnp_PayDate: rest.vnp_CreateDate,
      vnp_ResponseCode: success ? '00' : '24',
      vnp_TmnCode: rest.vnp_TmnCode,
      vnp_TransactionNo: String(14000000 + Math.floor(Math.random() * 999999)),
      vnp_TransactionStatus: success ? '00' : '02',
      vnp_TxnRef: rest.vnp_TxnRef,
    };
    return {
      ...result,
      vnp_SecureHash: hmac('sha512', CREDS.vnpay.hashSecret, vnpQuery(result)),
    };
  }

  /** MoMo: the wallet paid; returns the signed IPN body. */
  momoIpn(orderId: string, success = true): Record<string, string | number> {
    const o = this.momoOrders.get(orderId)!;
    o.paid = success;
    const f: Record<string, string | number> = {
      partnerCode: CREDS.momo.partnerCode,
      orderId,
      requestId: orderId,
      amount: o.amount,
      orderInfo: 'Order',
      orderType: 'momo_wallet',
      transId: o.transId,
      resultCode: success ? 0 : 1006,
      message: success ? 'Successful.' : 'Transaction denied by user.',
      payType: 'qr',
      responseTime: Date.now(),
      extraData: '',
    };
    return {
      ...f,
      signature: momoSig({ ...f, accessKey: CREDS.momo.accessKey }, [
        'accessKey',
        'amount',
        'extraData',
        'message',
        'orderId',
        'orderInfo',
        'orderType',
        'partnerCode',
        'payType',
        'requestId',
        'responseTime',
        'resultCode',
        'transId',
      ]),
    };
  }
}
