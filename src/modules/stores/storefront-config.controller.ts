import { Controller, Get } from '@nestjs/common';
import { ApiOkResponse, ApiOperation } from '@nestjs/swagger';
import type { StoreContext } from './context/store-context.js';
import { StoreCtx } from './context/store-context.js';
import { Storefront } from './context/storefront.decorator.js';
import { StorefrontConfigDto } from './dto/store-config.dto.js';
import { StoresQuery } from './stores.query.js';

@Storefront('config')
@Controller('store/config')
export class StorefrontConfigController {
  constructor(private readonly stores: StoresQuery) {}

  @Get()
  @ApiOperation({
    summary:
      'Resolved store, its locales and currencies, and the store switcher',
    operationId: 'getStoreConfig',
  })
  @ApiOkResponse({ type: StorefrontConfigDto })
  async config(@StoreCtx() ctx: StoreContext): Promise<StorefrontConfigDto> {
    const snap = await this.stores.snapshot();
    const store = snap.byId.get(ctx.storeId)!;
    return {
      store: {
        code: store.code,
        name: store.name,
        baseUrl: store.baseUrl,
        countryCode: store.countryCode,
        pricesIncludeTax: store.pricesIncludeTax,
        defaultLocale: store.defaultLocaleCode,
        defaultCurrency: store.defaultCurrencyCode,
      },
      website: { code: store.websiteCode, name: store.websiteName },
      locale: ctx.localeCode,
      currency: ctx.currencyCode,
      locales: store.localeCodes
        .map((c) => snap.locales.get(c))
        .filter((l) => l?.isActive)
        .map((l) => ({ code: l!.code, name: l!.name })),
      currencies: store.currencyCodes
        .map((c) => snap.currencies.get(c))
        .filter((c) => c?.isActive)
        .map((c) => ({
          code: c!.code,
          name: c!.name,
          symbol: c!.symbol,
          minorUnits: c!.minorUnits,
        })),
      stores: [...snap.byId.values()]
        .filter((s) => s.websiteId === store.websiteId && s.isActive)
        .map((s) => ({
          code: s.code,
          name: s.name,
          baseUrl: s.baseUrl,
          defaultLocale: s.defaultLocaleCode,
        })),
    };
  }
}
