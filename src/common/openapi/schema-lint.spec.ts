import { untypedProperties } from './schema-lint.js';

describe('untypedProperties', () => {
  it('flags bare objects, not maps or nullable refs', () => {
    expect(
      untypedProperties({
        components: {
          schemas: {
            A: {
              properties: {
                when: { type: 'object', nullable: true },
                map: {
                  type: 'object',
                  additionalProperties: { type: 'integer' },
                },
                ref: {
                  type: 'object',
                  nullable: true,
                  allOf: [{ $ref: '#/x' }],
                },
                ok: { type: 'string' },
              },
            },
          },
        },
      }),
    ).toEqual(['A.when']);
  });
});
