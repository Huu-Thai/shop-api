import { createHmac } from 'node:crypto';
import { CodProvider } from './cod.provider.js';
import { providerRequest } from './http.js';
import { MomoProvider, momoSignature } from './momo.provider.js';
import { PayPalProvider } from './paypal.provider.js';
import { PaymentAdapters } from './registry.js';
import { StripeProvider } from './stripe.provider.js';
import {
  fromDecimal,
  InvalidSignatureError,
  type PaymentRequest,
  ProviderError,
  type StoredPayment,
  toDecimal,
} from './types.js';
import { txnRef, VnpayProvider, vnpDate, vnpQuery } from './vnpay.provider.js';

type Handler = (
  url: string,
  init: RequestInit,
) => { status?: number; body: unknown };

/** A fetch double: routes by "METHOD path" and records every call. */
function scripted(routes: Record<string, Handler>) {
  const calls: { method: string; url: string; init: RequestInit }[] = [];
  const impl = (async (input: string | URL, init: RequestInit = {}) => {
    const url = String(input);
    const method = init.method ?? 'GET';
    calls.push({ method, url, init });
    const key = Object.keys(routes).find((k) => {
      const [m, p] = k.split(' ');
      return m === method && new URL(url).pathname.endsWith(p);
    });
    if (!key)
      return new Response(JSON.stringify({ message: 'no route' }), {
        status: 404,
      });
    const out = routes[key](url, init);
    return new Response(JSON.stringify(out.body), {
      status: out.status ?? 200,
    });
  }) as typeof fetch;
  return { impl, calls };
}

const req = (extra: Partial<PaymentRequest> = {}): PaymentRequest => ({
  paymentId: '11111111-2222-4333-8444-555555555555',
  amount: 6220n,
  currencyCode: 'USD',
  minorUnits: 2,
  orderId: 'o1',
  orderNumber: 'US-000001',
  email: 'a@b.co',
  localeCode: 'en-US',
  returnUrl: 'https://shop.example/return',
  cancelUrl: 'https://shop.example/cancel',
  notifyUrl: 'https://api.shop.example/hook',
  clientIp: '1.2.3.4',
  createdAt: new Date('2026-11-14T03:00:00Z'),
  ...extra,
});

const stored = (extra: Partial<StoredPayment> = {}): StoredPayment => ({
  id: 'p1',
  providerRef: 'ref1',
  captureRef: 'cap1',
  amount: 6220n,
  currencyCode: 'USD',
  minorUnits: 2,
  createdAt: new Date('2026-11-14T03:00:00Z'),
  capturedAt: new Date('2026-11-14T03:05:00Z'),
  ...extra,
});

const body = (init: RequestInit) => JSON.parse(String(init.body));

describe('money and http helpers', () => {
  it('converts between minor units and decimal strings', () => {
    expect(toDecimal(6220n, 2)).toBe('62.20');
    expect(toDecimal(5n, 2)).toBe('0.05');
    expect(toDecimal(580000n, 0)).toBe('580000');
    expect(fromDecimal('25.38', 2)).toBe(2538n);
    expect(fromDecimal('7', 2)).toBe(700n);
    expect(fromDecimal('1000', 0)).toBe(1000n);
  });

  it('surfaces provider errors with their message; tolerated statuses return the body', async () => {
    const f = scripted({
      'GET /err': () => ({
        status: 402,
        body: { error: { message: 'Card declined' } },
      }),
      'GET /text': () => ({ status: 500, body: 'oops' }),
      'GET /ok': () => ({ status: 422, body: { details: [] } }),
    });
    await expect(providerRequest(f.impl, 'http://x/err')).rejects.toThrow(
      'Card declined',
    );
    await expect(providerRequest(f.impl, 'http://x/text')).rejects.toThrow(
      'error 500',
    );
    expect(
      (await providerRequest(f.impl, 'http://x/ok', { ok: [422] })).status,
    ).toBe(422);
    const down = (async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof fetch;
    await expect(providerRequest(down, 'http://x')).rejects.toBeInstanceOf(
      ProviderError,
    );
  });
});

describe('StripeProvider', () => {
  const creds = {
    secretKey: 'sk',
    publishableKey: 'pk',
    webhookSecret: 'whsec',
  };
  const intent = (status: string, extra: object = {}) => ({
    id: 'pi_1',
    status,
    amount: 6220,
    client_secret: 'pi_1_secret',
    ...extra,
  });

  it('creates an intent (form body, key, idempotency) and returns the client secret', async () => {
    const f = scripted({
      'POST /v1/payment_intents': () => ({
        body: intent('requires_payment_method'),
      }),
    });
    const s = new StripeProvider(creds, f.impl);
    const r = await s.createPayment(req());
    expect(r).toMatchObject({
      providerRef: 'pi_1',
      action: {
        type: 'CLIENT_SECRET',
        clientSecret: 'pi_1_secret',
        publishableKey: 'pk',
      },
    });
    const call = f.calls[0];
    expect(new Headers(call.init.headers).get('authorization')).toBe(
      'Bearer sk',
    );
    expect(new Headers(call.init.headers).get('idempotency-key')).toBe(
      'payment-11111111-2222-4333-8444-555555555555',
    );
    expect(String(call.init.body)).toContain('amount=6220');
    expect(String(call.init.body)).toContain('currency=usd');
  });

  it('verifies webhook signatures (and their age) and normalises events', async () => {
    const now = 1_800_000_000_000;
    const s = new StripeProvider(creds, fetch, () => now);
    const signed = (payload: object, t = now / 1000, secret = 'whsec') => {
      const raw = JSON.stringify(payload);
      return {
        headers: {
          'stripe-signature': `t=${t},v1=${createHmac('sha256', secret).update(`${t}.${raw}`).digest('hex')}`,
        },
        rawBody: Buffer.from(raw),
        query: {},
      };
    };
    const ok = await s.parseWebhook(
      signed({
        id: 'evt_1',
        type: 'payment_intent.succeeded',
        data: {
          object: intent('succeeded', {
            amount_received: 6220,
            latest_charge: 'ch_1',
          }),
        },
      }),
    );
    expect(ok).toMatchObject({
      eventId: 'evt_1',
      type: 'CAPTURED',
      providerRef: 'pi_1',
      captureRef: 'ch_1',
      amount: 6220n,
    });
    const failed = await s.parseWebhook(
      signed({
        id: 'e2',
        type: 'payment_intent.payment_failed',
        data: {
          object: intent('requires_payment_method', {
            last_payment_error: { message: 'Declined' },
          }),
        },
      }),
    );
    expect(failed).toMatchObject({ type: 'FAILED', reason: 'Declined' });
    expect(
      (
        await s.parseWebhook(
          signed({
            id: 'e3',
            type: 'payment_intent.canceled',
            data: { object: intent('canceled') },
          }),
        )
      ).type,
    ).toBe('CANCELED');
    expect(
      (
        await s.parseWebhook(
          signed({
            id: 'e4',
            type: 'charge.updated',
            data: { object: intent('processing') },
          }),
        )
      ).type,
    ).toBe('IGNORED');
    await expect(
      s.parseWebhook(signed({ id: 'x' }, now / 1000, 'other')),
    ).rejects.toBeInstanceOf(InvalidSignatureError);
    await expect(
      s.parseWebhook(signed({ id: 'x' }, now / 1000 - 3600)),
    ).rejects.toBeInstanceOf(InvalidSignatureError);
    await expect(
      s.parseWebhook({ headers: {}, rawBody: Buffer.from('{}'), query: {} }),
    ).rejects.toBeInstanceOf(InvalidSignatureError);
    expect(s.ack('invalid-signature').status).toBe(400);
    expect(s.ack('ok')).toEqual({ status: 200, body: { received: true } });
  });

  it('reads status, refunds and cancels', async () => {
    let refundStatus = 'succeeded';
    const f = scripted({
      'GET /v1/payment_intents/ref1': () => ({
        body: intent('succeeded', { id: 'ref1' }),
      }),
      'POST /v1/refunds': () => ({
        body: { id: 're_1', status: refundStatus },
      }),
      'POST /v1/payment_intents/ref1/cancel': () => ({
        body: intent('canceled', { id: 'ref1' }),
      }),
      'GET /v1/refunds/re_9': () => ({
        body: { id: 're_9', status: 'succeeded' },
      }),
    });
    const s = new StripeProvider(creds, f.impl);
    expect(
      await s.refundStatus(stored(), { providerRef: 're_9' }),
    ).toMatchObject({ providerRef: 're_9', status: 'SUCCEEDED' });
    expect((await s.status(stored())).type).toBe('CAPTURED');
    expect((await s.handleReturn(stored())).type).toBe('CAPTURED');
    expect(await s.refund(stored(), 100n, 'r1')).toMatchObject({
      providerRef: 're_1',
      status: 'SUCCEEDED',
    });
    refundStatus = 'pending';
    expect((await s.refund(stored(), 100n, 'r2')).status).toBe('PENDING');
    refundStatus = 'failed';
    expect((await s.refund(stored(), 100n, 'r3')).status).toBe('FAILED');
    await s.cancel(stored());
    await s.cancel(stored({ providerRef: null }));
    expect(f.calls.filter((c) => c.url.endsWith('/cancel'))).toHaveLength(1);
  });
});

describe('PayPalProvider', () => {
  const creds = { clientId: 'cid', clientSecret: 'cs', webhookId: 'WH' };
  const order = (status: string, capture?: object) => ({
    id: 'PP1',
    status,
    links: [{ rel: 'payer-action', href: 'https://paypal/approve?token=PP1' }],
    purchase_units: [{ payments: capture ? { captures: [capture] } : {} }],
  });

  function setup(overrides: Record<string, Handler> = {}) {
    const f = scripted({
      'POST /v1/oauth2/token': () => ({
        body: { access_token: 'tok', expires_in: 3600 },
      }),
      'POST /v2/checkout/orders': () => ({
        status: 201,
        body: order('PAYER_ACTION_REQUIRED'),
      }),
      'POST /v2/checkout/orders/ref1/capture': () => ({
        status: 201,
        body: order('COMPLETED', {
          id: 'CAP1',
          status: 'COMPLETED',
          amount: { value: '62.20' },
        }),
      }),
      'GET /v2/checkout/orders/ref1': () => ({ body: order('APPROVED') }),
      'POST /v1/notifications/verify-webhook-signature': (_u, i) => ({
        body: {
          verification_status:
            body(i).transmission_sig === 'good' ? 'SUCCESS' : 'FAILURE',
        },
      }),
      'POST /v2/payments/captures/cap1/refund': () => ({
        status: 201,
        body: { id: 'RF1', status: 'COMPLETED' },
      }),
      'GET /v2/payments/refunds/RF1': () => ({
        body: { id: 'RF1', status: 'PENDING' },
      }),
      ...overrides,
    });
    return { f, p: new PayPalProvider(creds, true, f.impl) };
  }

  it('creates an order (OAuth once, request id, decimal amount) and returns the approval link', async () => {
    const { f, p } = setup();
    const r = await p.createPayment(req());
    expect(r).toMatchObject({
      providerRef: 'PP1',
      action: { type: 'REDIRECT', url: 'https://paypal/approve?token=PP1' },
    });
    const create = f.calls.find((c) => c.url.endsWith('/v2/checkout/orders'))!;
    expect(body(create.init).purchase_units[0].amount).toEqual({
      currency_code: 'USD',
      value: '62.20',
    });
    expect(new Headers(create.init.headers).get('paypal-request-id')).toContain(
      'payment-',
    );
    await p.createPayment(req());
    expect(f.calls.filter((c) => c.url.endsWith('/oauth2/token'))).toHaveLength(
      1,
    );
    expect(new PayPalProvider(creds, false, f.impl)).toBeDefined();
  });

  it('captures on return; reports approval, already-captured and refusals', async () => {
    const { p } = setup();
    expect(await p.handleReturn(stored(), { token: 'ref1' })).toMatchObject({
      type: 'CAPTURED',
      captureRef: 'CAP1',
      amount: 6220n,
    });
    await expect(
      p.handleReturn(stored(), { token: 'other' }),
    ).rejects.toBeInstanceOf(InvalidSignatureError);
    expect((await p.status(stored())).type).toBe('APPROVED');
    const again = setup({
      'POST /v2/checkout/orders/ref1/capture': () => ({
        status: 422,
        body: { details: [{ issue: 'ORDER_ALREADY_CAPTURED' }] },
      }),
      'GET /v2/checkout/orders/ref1': () => ({
        body: order('COMPLETED', {
          id: 'CAP1',
          status: 'COMPLETED',
          amount: { value: '62.20' },
        }),
      }),
    });
    expect((await again.p.capture(stored())).type).toBe('CAPTURED');
    const refused = setup({
      'POST /v2/checkout/orders/ref1/capture': () => ({
        status: 422,
        body: { details: [{ issue: 'ORDER_NOT_APPROVED' }] },
      }),
    });
    expect(await refused.p.capture(stored())).toMatchObject({
      type: 'FAILED',
      reason: 'ORDER_NOT_APPROVED',
    });
    const declined = setup({
      'GET /v2/checkout/orders/ref1': () => ({
        body: order('COMPLETED', {
          id: 'C',
          status: 'DECLINED',
          amount: { value: '1' },
        }),
      }),
    });
    expect((await declined.p.status(stored())).type).toBe('FAILED');
    const voided = setup({
      'GET /v2/checkout/orders/ref1': () => ({ body: order('VOIDED') }),
    });
    expect((await voided.p.status(stored())).type).toBe('CANCELED');
    const created = setup({
      'GET /v2/checkout/orders/ref1': () => ({ body: order('CREATED') }),
    });
    expect((await created.p.status(stored())).type).toBe('IGNORED');
    const noLink = setup({
      'POST /v2/checkout/orders': () => ({
        status: 201,
        body: { id: 'X', status: 'CREATED', links: [] },
      }),
    });
    await expect(noLink.p.createPayment(req())).rejects.toThrow(
      'no approval link',
    );
  });

  it('verifies webhooks with PayPal and maps events; refunds captures', async () => {
    const { p } = setup();
    const hook = (event: object, sig = 'good') => ({
      headers: {
        'paypal-transmission-sig': sig,
        'paypal-transmission-id': 't',
        'paypal-transmission-time': 'now',
        'paypal-auth-algo': 'SHA256',
        'paypal-cert-url': 'https://cert',
      },
      rawBody: Buffer.from(JSON.stringify(event)),
      query: {},
    });
    const resource = {
      id: 'CAP1',
      amount: { value: '62.20', currency_code: 'USD' },
      supplementary_data: { related_ids: { order_id: 'PP1' } },
    };
    expect(
      await p.parseWebhook(
        hook({ id: 'WE1', event_type: 'PAYMENT.CAPTURE.COMPLETED', resource }),
      ),
    ).toMatchObject({ type: 'CAPTURED', providerRef: 'PP1', amount: 6220n });
    expect(
      (
        await p.parseWebhook(
          hook({
            id: 'WE2',
            event_type: 'PAYMENT.CAPTURE.COMPLETED',
            resource: {
              ...resource,
              amount: { value: '500', currency_code: 'JPY' },
            },
          }),
        )
      ).amount,
    ).toBe(500n);
    expect(
      (
        await p.parseWebhook(
          hook({
            id: 'WE3',
            event_type: 'CHECKOUT.ORDER.APPROVED',
            resource: { id: 'PP1' },
          }),
        )
      ).type,
    ).toBe('APPROVED');
    expect(
      (
        await p.parseWebhook(
          hook({ id: 'WE4', event_type: 'PAYMENT.CAPTURE.DENIED', resource }),
        )
      ).type,
    ).toBe('FAILED');
    expect(
      (
        await p.parseWebhook(
          hook({
            id: 'WE5',
            event_type: 'PAYMENT.CAPTURE.COMPLETED',
            resource: { id: 'C' },
          }),
        )
      ).amount,
    ).toBeNull();
    expect(
      (
        await p.parseWebhook(
          hook({ id: 'WE6', event_type: 'BILLING.X', resource }),
        )
      ).type,
    ).toBe('IGNORED');
    await expect(
      p.parseWebhook(hook({ id: 'W', event_type: 'X', resource }, 'bad')),
    ).rejects.toBeInstanceOf(InvalidSignatureError);
    expect(await p.refund(stored(), 2538n, 'r1', 'Sorry')).toMatchObject({
      providerRef: 'RF1',
      status: 'SUCCEEDED',
    });
    const pending = setup({
      'POST /v2/payments/captures/cap1/refund': () => ({
        status: 201,
        body: { id: 'RF', status: 'PENDING' },
      }),
    });
    expect((await pending.p.refund(stored(), 1n, 'r', '')).status).toBe(
      'PENDING',
    );
    const failed = setup({
      'POST /v2/payments/captures/cap1/refund': () => ({
        status: 201,
        body: { id: 'RF', status: 'CANCELLED' },
      }),
    });
    expect((await failed.p.refund(stored(), 1n, 'r', '')).status).toBe(
      'FAILED',
    );
    expect(
      (await p.refundStatus(stored(), { providerRef: 'RF1' })).status,
    ).toBe('PENDING');
    expect(p.ack('invalid-signature').status).toBe(400);
    expect(p.ack('ok').status).toBe(200);
  });
});

describe('VnpayProvider', () => {
  const creds = { tmnCode: 'TMN', hashSecret: 'SECRET' };
  const sign = (q: Record<string, string>) =>
    createHmac('sha512', 'SECRET').update(vnpQuery(q)).digest('hex');

  it('builds the signed pay URL in Vietnam time (VND only)', async () => {
    const v = new VnpayProvider(creds, true);
    expect(vnpDate(new Date('2026-11-14T20:30:05Z'))).toBe('20261115033005');
    expect(vnpQuery({ b: 'x y', a: 'é' })).toBe('a=%C3%A9&b=x+y');
    expect(txnRef('a-b-c')).toBe('abc');
    const r = await v.createPayment(
      req({
        currencyCode: 'VND',
        amount: 580000n,
        minorUnits: 0,
        localeCode: 'vi-VN',
      }),
    );
    const u = new URL((r.action as { url: string }).url);
    expect(u.origin + u.pathname).toBe(
      'https://sandbox.vnpayment.vn/paymentv2/vpcpay.html',
    );
    const params = Object.fromEntries(u.searchParams.entries());
    const { vnp_SecureHash, ...rest } = params;
    expect(vnp_SecureHash).toBe(sign(rest));
    expect(rest).toMatchObject({
      vnp_Amount: '58000000',
      vnp_Locale: 'vn',
      vnp_CreateDate: '20261114100000',
      vnp_ExpireDate: '20261114101500',
    });
    await expect(v.createPayment(req())).rejects.toThrow('VND only');
    expect(new VnpayProvider(creds, false)).toBeDefined();
  });

  it('verifies returns and IPNs; answers IPNs the VNPay way', async () => {
    const v = new VnpayProvider(creds, true);
    const q = {
      vnp_Amount: '58000000',
      vnp_ResponseCode: '00',
      vnp_TransactionStatus: '00',
      vnp_TxnRef: 'ref1',
      vnp_TransactionNo: '123',
    };
    const signed = {
      ...q,
      vnp_SecureHash: sign(q),
      vnp_SecureHashType: 'SHA512',
    };
    expect(
      await v.parseWebhook({
        headers: {},
        rawBody: Buffer.from(''),
        query: signed,
      }),
    ).toMatchObject({ type: 'CAPTURED', amount: 580000n, captureRef: '123' });
    const fail = { ...q, vnp_ResponseCode: '24' };
    expect(
      (await v.handleReturn(stored(), { ...fail, vnp_SecureHash: sign(fail) }))
        .type,
    ).toBe('FAILED');
    await expect(
      v.handleReturn(stored(), { ...signed, vnp_Amount: '1' }),
    ).rejects.toBeInstanceOf(InvalidSignatureError);
    await expect(v.handleReturn(stored(), q)).rejects.toBeInstanceOf(
      InvalidSignatureError,
    );
    expect(v.ack('ok').body).toEqual({
      RspCode: '00',
      Message: 'Confirm Success',
    });
    for (const [reason, code] of [
      ['duplicate', '02'],
      ['invalid-signature', '97'],
      ['unknown-payment', '01'],
      ['amount-mismatch', '04'],
      ['error', '99'],
    ] as const)
      expect((v.ack(reason).body as { RspCode: string }).RspCode).toBe(code);
  });

  it('refunds and queries through the merchant API with pipe-joined checksums', async () => {
    const seen: Record<string, string>[] = [];
    let code = '00';
    const f = scripted({
      'POST /merchant_webapi/api/transaction': (_u, i) => {
        const b = body(i);
        seen.push(b);
        return {
          body:
            b.vnp_Command === 'refund'
              ? {
                  vnp_ResponseCode: code,
                  vnp_TransactionNo: 'R1',
                  vnp_Message: 'x',
                }
              : { vnp_ResponseCode: code, vnp_TransactionStatus: '00' },
        };
      },
    });
    const v = new VnpayProvider(
      { ...creds, apiUrl: 'http://emu/merchant_webapi/api/transaction' },
      true,
      f.impl,
    );
    const p = stored({ amount: 580000n, currencyCode: 'VND', minorUnits: 0 });
    expect((await v.refund(p, 100000n, 'refund-1', 'Partial')).status).toBe(
      'SUCCEEDED',
    );
    const r = seen[0];
    expect(r).toMatchObject({
      vnp_TransactionType: '03',
      vnp_Amount: '10000000',
      vnp_TransactionDate: '20261114100000',
    });
    const fields = [
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
    ];
    expect(r.vnp_SecureHash).toBe(
      createHmac('sha512', 'SECRET')
        .update(fields.map((k) => r[k]).join('|'))
        .digest('hex'),
    );
    expect((await v.refund(p, 580000n, 'refund-2', '')).status).toBe(
      'SUCCEEDED',
    );
    expect(seen[1].vnp_TransactionType).toBe('02');
    expect((await v.status(p)).type).toBe('CAPTURED');
    code = '91';
    expect(await v.refund(p, 1n, 'r3', 'x')).toMatchObject({
      status: 'FAILED',
      reason: expect.stringContaining('91'),
    });
    expect((await v.status(p)).type).toBe('IGNORED');
  });
});

describe('MomoProvider', () => {
  const creds = { partnerCode: 'MOMO', accessKey: 'ak', secretKey: 'sk' };
  const IPN = [
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
  ];

  it('creates a wallet payment with the documented signature (VND only)', async () => {
    let result = 0;
    const f = scripted({
      'POST /v2/gateway/api/create': () => ({
        body: {
          resultCode: result,
          message: 'm',
          payUrl: result ? undefined : 'https://momo/pay',
          deeplink: 'momo://x',
        },
      }),
    });
    const m = new MomoProvider(
      { ...creds, apiBase: 'http://emu' },
      true,
      f.impl,
    );
    const r = await m.createPayment(
      req({ currencyCode: 'VND', amount: 140000n, minorUnits: 0 }),
    );
    expect(r.action).toMatchObject({
      type: 'REDIRECT',
      url: 'https://momo/pay',
      deeplink: 'momo://x',
    });
    const b = body(f.calls[0].init);
    expect(b.signature).toBe(
      momoSignature('sk', { ...b, accessKey: 'ak' }, [
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
      ]),
    );
    expect(b).toMatchObject({
      amount: 140000,
      requestType: 'captureWallet',
      ipnUrl: 'https://api.shop.example/hook',
      lang: 'en',
    });
    result = 22;
    await expect(
      m.createPayment(req({ currencyCode: 'VND', minorUnits: 0 })),
    ).rejects.toThrow('MoMo refused');
    await expect(m.createPayment(req())).rejects.toThrow('VND only');
    expect(new MomoProvider(creds, false)).toBeDefined();
  });

  it('verifies IPNs and returns; refunds and queries', async () => {
    let refundCode = 0;
    const refundQueries: Record<string, string>[] = [];
    let refundQuery: object = {
      resultCode: 0,
      message: 'ok',
      refundTrans: [{ orderId: 'r1', resultCode: 0, transId: 77 }],
    };
    const f = scripted({
      'POST /v2/gateway/api/refund': () => ({
        body: { resultCode: refundCode, message: 'm', transId: 9 },
      }),
      'POST /v2/gateway/api/query': () => ({
        body: { orderId: 'ref1', resultCode: 0, transId: 5, amount: 140000 },
      }),
      'POST /v2/gateway/api/refund/query': (_u, i) => {
        refundQueries.push(body(i));
        return { body: refundQuery };
      },
    });
    const m = new MomoProvider(
      { ...creds, apiBase: 'http://emu' },
      true,
      f.impl,
    );
    const fields = {
      partnerCode: 'MOMO',
      orderId: 'ref1',
      requestId: 'ref1',
      amount: 140000,
      orderInfo: 'o',
      orderType: 'momo_wallet',
      transId: 5,
      resultCode: 0,
      message: 'ok',
      payType: 'qr',
      responseTime: 1,
      extraData: '',
    };
    const sig = momoSignature('sk', { ...fields, accessKey: 'ak' }, IPN);
    expect(
      await m.parseWebhook({
        headers: {},
        rawBody: Buffer.from(JSON.stringify({ ...fields, signature: sig })),
        query: {},
      }),
    ).toMatchObject({ type: 'CAPTURED', captureRef: '5', amount: 140000n });
    const pending = { ...fields, resultCode: 1000 };
    expect(
      (
        await m.handleReturn(
          stored(),
          Object.fromEntries(
            Object.entries({
              ...pending,
              signature: momoSignature(
                'sk',
                { ...pending, accessKey: 'ak' },
                IPN,
              ),
            }).map(([k, v]) => [k, String(v)]),
          ),
        )
      ).type,
    ).toBe('IGNORED');
    const denied = { ...fields, resultCode: 1006 };
    expect(
      (
        await m.handleReturn(stored(), {
          ...(denied as unknown as Record<string, string>),
          signature: momoSignature('sk', { ...denied, accessKey: 'ak' }, IPN),
        })
      ).type,
    ).toBe('FAILED');
    await expect(
      m.parseWebhook({
        headers: {},
        rawBody: Buffer.from(JSON.stringify({ ...fields, signature: 'x' })),
        query: {},
      }),
    ).rejects.toBeInstanceOf(InvalidSignatureError);
    expect(await m.refund(stored(), 140000n, 'r1', 'x')).toMatchObject({
      status: 'SUCCEEDED',
      providerRef: '9',
    });
    refundCode = 1000;
    expect((await m.refund(stored(), 1n, 'r2', 'x')).status).toBe('PENDING');
    refundCode = 7;
    expect((await m.refund(stored(), 1n, 'r3', 'x')).status).toBe('FAILED');
    expect((await m.status(stored())).type).toBe('CAPTURED');
    expect(await m.refundStatus(stored(), { id: 'r1' })).toMatchObject({
      status: 'SUCCEEDED',
      providerRef: '77',
    });
    expect(refundQueries[0].signature).toBe(
      momoSignature('sk', { ...refundQueries[0], accessKey: 'ak' }, [
        'accessKey',
        'orderId',
        'partnerCode',
        'requestId',
      ]),
    );
    expect(refundQueries[0].orderId).toBe('ref1');
    refundQuery = {
      resultCode: 0,
      message: 'ok',
      refundTrans: [
        { orderId: 'r2', resultCode: 1000 },
        { orderId: 'r3', resultCode: 99 },
      ],
    };
    expect((await m.refundStatus(stored(), { id: 'r2' })).status).toBe(
      'PENDING',
    );
    expect((await m.refundStatus(stored(), { id: 'r3' })).status).toBe(
      'FAILED',
    );
    expect(await m.refundStatus(stored(), { id: 'r9' })).toMatchObject({
      status: 'FAILED',
      reason: 'MoMo has no such refund',
    });
    refundQuery = { resultCode: 1000, message: 'processing' };
    expect((await m.refundStatus(stored(), { id: 'r1' })).status).toBe(
      'PENDING',
    );
    expect(m.ack('ok').status).toBe(204);
    expect(m.ack('invalid-signature').status).toBe(400);
  });
});

describe('CodProvider and the registry', () => {
  it('cash on delivery is accepted at once and refunded by hand', async () => {
    const c = new CodProvider();
    expect(await c.createPayment(req())).toMatchObject({
      accepted: true,
      action: { type: 'NONE' },
    });
    await expect(c.parseWebhook()).rejects.toThrow('no notifications');
    expect((await c.handleReturn(stored())).type).toBe('IGNORED');
    expect((await c.refund(stored(), 1n, 'r1')).status).toBe('SUCCEEDED');
    expect(c.ack('ok').status).toBe(404);
  });

  it('builds adapters from sealed credentials and validates them', () => {
    const secrets = {
      open: vi.fn(() => ({
        secretKey: 'sk',
        publishableKey: 'pk',
        webhookSecret: 'w',
      })),
    };
    const a = new PaymentAdapters(secrets as never);
    for (const code of ['STRIPE', 'PAYPAL', 'VNPAY', 'MOMO', 'COD'] as const)
      expect(
        a.for({
          id: 'x',
          code,
          mode: 'TEST',
          credentials: code === 'COD' ? null : 'sealed',
        }).code,
      ).toBe(code);
    expect(() =>
      PaymentAdapters.validate('STRIPE', { secretKey: 'x' }),
    ).toThrow('publishableKey, webhookSecret');
    expect(() =>
      PaymentAdapters.validate('MOMO', {
        partnerCode: 'p',
        accessKey: 'a',
        secretKey: 's',
        apiBase: 'ftp://x',
      }),
    ).toThrow('apiBase must be a URL');
    expect(() => PaymentAdapters.validate('COD', {})).not.toThrow();
  });
});
