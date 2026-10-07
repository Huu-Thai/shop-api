import type { PrismaTransaction } from '../../database/prisma.service.js';

/** Next number of a document sequence (`order:us`), atomically (row upsert, no gaps on commit). */
export async function nextNumber(
  tx: PrismaTransaction,
  scope: string,
): Promise<bigint> {
  const [row] = await tx.$queryRaw<{ value: bigint }[]>`
    INSERT INTO document_sequences (scope, next_value, updated_at) VALUES (${scope}, 2, now())
    ON CONFLICT (scope) DO UPDATE SET next_value = document_sequences.next_value + 1, updated_at = now()
    RETURNING next_value - 1 AS value`;
  return BigInt(row.value);
}

/** `US-000042` style numbers. */
export const formatNumber = (prefix: string, n: bigint, width = 6) =>
  `${prefix}-${n.toString().padStart(width, '0')}`;
