/**
 * Permission catalogue — the single source of truth for RBAC. A permission is
 * `<area>:<action>`; roles and API keys hold a subset. `*` grants everything and
 * `<area>:*` every action in an area. Later phases add their areas here.
 */
export const PERMISSIONS = {
  // Phase 0 — back office
  'admin-users:read': 'View admin users',
  'admin-users:write': 'Create, update and disable admin users',
  'roles:read': 'View roles and permissions',
  'roles:write': 'Create, update and delete roles',
  'api-keys:read': 'View API keys',
  'api-keys:write': 'Create and revoke API keys',
  'audit-logs:read': 'View the audit log',
  // Planned areas (PLAN.md §14) — usable in roles now, enforced when their modules ship.
  'stores:read': 'View websites, stores, locales and currencies',
  'stores:write': 'Manage websites, stores, locales and currencies',
  'catalog:read': 'View categories, attributes and products',
  'catalog:write': 'Manage categories, attributes and products',
  'pricing:read': 'View price books and tax',
  'pricing:write': 'Manage price books and tax',
  'inventory:read': 'View stock',
  'inventory:write': 'Adjust stock and sources',
  'cms:read': 'View pages, posts, blocks, menus, banners and sliders',
  'cms:write': 'Edit content',
  'cms:publish': 'Publish and schedule content',
  'marketing:read': 'View campaigns, promotions and coupons',
  'marketing:write': 'Manage campaigns, promotions and coupons',
  'customers:read': 'View customers and loyalty',
  'customers:write': 'Manage customers and loyalty',
  'orders:read': 'View orders, payments and shipments',
  'orders:write': 'Manage orders, refunds and shipments',
  'jobs:read': 'View jobs and executions',
  'jobs:write': 'Run and schedule jobs, imports and exports',
  // Phase 7 — integrations
  'webhooks:read': 'View outgoing webhooks and their deliveries',
  'webhooks:write': 'Manage outgoing webhooks',
  'settings:write': 'Change system settings (search engine, payment providers)',
} as const;

export type Permission = keyof typeof PERMISSIONS;

const AREAS = new Set(Object.keys(PERMISSIONS).map((p) => p.split(':')[0]));

/** A grantable string: a catalogue permission, `<area>:*`, or `*`. */
export function isGrantable(value: string): boolean {
  if (value === '*') return true;
  if (value in PERMISSIONS) return true;
  const [area, action] = value.split(':');
  return action === '*' && AREAS.has(area);
}

/** Does `granted` satisfy `required`? */
export function hasPermission(
  granted: readonly string[],
  required: string,
): boolean {
  if (granted.includes('*') || granted.includes(required)) return true;
  return granted.includes(`${required.split(':')[0]}:*`);
}

/** Can a holder of `granted` hand out `wanted`? Prevents privilege escalation via roles / keys. */
export function canGrant(granted: readonly string[], wanted: string): boolean {
  if (granted.includes('*')) return true;
  if (wanted === '*') return false;
  if (wanted.endsWith(':*')) return granted.includes(wanted);
  return hasPermission(granted, wanted);
}
