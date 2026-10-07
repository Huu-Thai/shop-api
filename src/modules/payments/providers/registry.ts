import { BadRequestException, Injectable } from '@nestjs/common';
import { SecretsService } from '../../../common/crypto/secrets.service.js';
import type {
  PaymentMode,
  PaymentProviderCode,
} from '../../../database/generated/prisma/client.js';
import { CodProvider } from './cod.provider.js';
import { type MomoCredentials, MomoProvider } from './momo.provider.js';
import { type PayPalCredentials, PayPalProvider } from './paypal.provider.js';
import { type StripeCredentials, StripeProvider } from './stripe.provider.js';
import type { PaymentAdapter } from './types.js';
import { type VnpayCredentials, VnpayProvider } from './vnpay.provider.js';

/** Credentials each provider needs (validated on save; `apiBase`/`payUrl`/`apiUrl` override hosts). */
export const REQUIRED_CREDENTIALS: Record<PaymentProviderCode, string[]> = {
  STRIPE: ['secretKey', 'publishableKey', 'webhookSecret'],
  PAYPAL: ['clientId', 'clientSecret', 'webhookId'],
  VNPAY: ['tmnCode', 'hashSecret'],
  MOMO: ['partnerCode', 'accessKey', 'secretKey'],
  COD: [],
};

export interface ProviderRow {
  id: string;
  code: PaymentProviderCode;
  mode: PaymentMode;
  credentials: string | null;
}

/**
 * Builds adapters from configured provider rows (credentials unsealed in memory only). Adding a
 * provider = implementing PaymentAdapter and registering it here.
 */
@Injectable()
export class PaymentAdapters {
  /** Tests point adapters at emulators. */
  fetchImpl: typeof fetch = (...a) => fetch(...a);

  constructor(private readonly secrets: SecretsService) {}

  for(row: ProviderRow): PaymentAdapter {
    const creds = row.credentials
      ? this.secrets.open<Record<string, string>>(row.credentials)
      : {};
    const sandbox = row.mode === 'TEST';
    switch (row.code) {
      case 'STRIPE':
        return new StripeProvider(
          creds as unknown as StripeCredentials,
          this.fetchImpl,
        );
      case 'PAYPAL':
        return new PayPalProvider(
          creds as unknown as PayPalCredentials,
          sandbox,
          this.fetchImpl,
        );
      case 'VNPAY':
        return new VnpayProvider(
          creds as unknown as VnpayCredentials,
          sandbox,
          this.fetchImpl,
        );
      case 'MOMO':
        return new MomoProvider(
          creds as unknown as MomoCredentials,
          sandbox,
          this.fetchImpl,
        );
      case 'COD':
        return new CodProvider();
    }
  }

  static validate(
    code: PaymentProviderCode,
    creds: Record<string, string>,
  ): void {
    const missing = REQUIRED_CREDENTIALS[code].filter((k) => !creds[k]);
    if (missing.length)
      throw new BadRequestException(
        `${code} credentials need: ${missing.join(', ')}`,
      );
    for (const k of ['apiBase', 'payUrl', 'apiUrl'])
      if (creds[k] && !/^https?:\/\/\S+$/.test(creds[k]))
        throw new BadRequestException(`${k} must be a URL`);
  }
}
