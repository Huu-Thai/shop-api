import type { Principal } from '../common/auth/principal.js';

export const ROOT: Principal = {
  type: 'admin',
  id: '00000000-0000-4000-8000-000000000001',
  label: 'root@shop.test',
  permissions: ['*'],
};
export const CATALOG_KEY: Principal = {
  type: 'api-key',
  id: 'k1',
  label: 'PIM',
  permissions: ['catalog:*'],
};
