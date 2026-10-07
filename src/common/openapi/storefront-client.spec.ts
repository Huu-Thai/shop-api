import { readFileSync } from 'node:fs';
import openapiTS, { astToString } from 'openapi-typescript';

const root = new URL('../../../', import.meta.url);
const strip = (s: string) => s.replace(/^(\/\*\*[\s\S]*?\*\/\s*)/, '').trim();

describe('@shop/storefront-client', () => {
  it('its generated types match the committed contract (run `npm run client:generate`)', async () => {
    const contract = JSON.parse(
      readFileSync(new URL('openapi/storefront.json', root), 'utf8'),
    );
    const expected = astToString(
      await openapiTS(contract, { rootTypes: false }),
    );
    const actual = readFileSync(
      new URL('packages/storefront-client/src/schema.ts', root),
      'utf8',
    );
    expect(strip(actual)).toBe(strip(expected));
  });
});
