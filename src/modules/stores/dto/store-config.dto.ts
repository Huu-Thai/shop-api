import { ApiProperty } from '@nestjs/swagger';

export class StorefrontLocaleDto {
  @ApiProperty({ example: 'vi-VN' }) code: string;
  @ApiProperty({ example: 'Tiếng Việt' }) name: string;
}

export class StorefrontCurrencyDto {
  @ApiProperty({ example: 'VND' }) code: string;
  @ApiProperty({ example: 'Vietnamese Dong' }) name: string;
  @ApiProperty({ example: '₫' }) symbol: string;
  @ApiProperty({ example: 0 }) minorUnits: number;
}

export class StorefrontStoreDto {
  @ApiProperty({ example: 'vn-vi' }) code: string;
  @ApiProperty() name: string;
  @ApiProperty({ nullable: true, type: String }) baseUrl: string | null;
  @ApiProperty({ example: 'VN' }) countryCode: string;
  @ApiProperty({ description: 'Catalog prices are shown tax-inclusive' })
  pricesIncludeTax: boolean;
  @ApiProperty({ example: 'vi-VN' }) defaultLocale: string;
  @ApiProperty({ example: 'VND' }) defaultCurrency: string;
}

export class StorefrontWebsiteDto {
  @ApiProperty({ example: 'vn' }) code: string;
  @ApiProperty() name: string;
}

export class StorefrontStoreSwitchDto {
  @ApiProperty() code: string;
  @ApiProperty() name: string;
  @ApiProperty({ nullable: true, type: String }) baseUrl: string | null;
  @ApiProperty() defaultLocale: string;
}

/** Everything a theme needs to boot: the resolved store, its locales/currencies and sibling stores. */
export class StorefrontConfigDto {
  @ApiProperty({ type: StorefrontStoreDto }) store: StorefrontStoreDto;
  @ApiProperty({ type: StorefrontWebsiteDto }) website: StorefrontWebsiteDto;
  @ApiProperty({
    example: 'vi-VN',
    description: 'Locale negotiated for this request',
  })
  locale: string;
  @ApiProperty({
    example: 'VND',
    description: 'Currency selected for this request',
  })
  currency: string;
  @ApiProperty({ type: [StorefrontLocaleDto] }) locales: StorefrontLocaleDto[];
  @ApiProperty({ type: [StorefrontCurrencyDto] })
  currencies: StorefrontCurrencyDto[];
  @ApiProperty({
    type: [StorefrontStoreSwitchDto],
    description: 'Active stores of the same website (store switcher)',
  })
  stores: StorefrontStoreSwitchDto[];
}
