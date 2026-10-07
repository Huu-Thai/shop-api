import { constraintFromMeta, FOREIGN_KEYS } from './constraints.js';

describe('constraintFromMeta', () => {
  it('reads the Prisma 7 driver-adapter shape', () => {
    expect(
      constraintFromMeta({
        driverAdapterError: {
          cause: { constraint: { index: 'fk_api_keys_created_by_id' } },
        },
      }),
    ).toBe('fk_api_keys_created_by_id');
    expect(
      constraintFromMeta({
        driverAdapterError: { cause: { constraint: 'uq_x' } },
      }),
    ).toBe('uq_x');
  });

  it('falls back to a top-level constraint field, else undefined', () => {
    expect(constraintFromMeta({ constraint: 'fk_a' })).toBe('fk_a');
    expect(constraintFromMeta(undefined)).toBeUndefined();
    expect(constraintFromMeta({})).toBeUndefined();
  });

  it('documents every foreign key', () => {
    // The migration e2e test asserts the exact set against the database.
    expect(Object.keys(FOREIGN_KEYS)).toHaveLength(182);
  });
});
