/** JWT audience of customer access tokens (admin tokens use `shop-admin`, so neither works as the other). */
export const CUSTOMER_AUDIENCE = 'shop-customer';
export const revokedCustomerSessionKey = (sid: string) =>
  `auth:customer-revoked-session:${sid}`;

export interface CustomerClaims {
  sub: string;
  sid: string;
  /** Website of the account: the token only works on that website's stores. */
  ws: string;
  iat: number;
  exp: number;
}
