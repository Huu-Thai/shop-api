import { createHmac } from 'node:crypto';

export { uuidFromName } from '../../common/utils/uuid.js';

/**
 * The guest's access token for an order: derived from a server secret, so a retried checkout can
 * hand out the same token again; only its hash is stored.
 */
export function orderAccessToken(secret: string, orderId: string): string {
  return createHmac('sha256', secret)
    .update(`order-access:${orderId}`)
    .digest('base64url');
}
