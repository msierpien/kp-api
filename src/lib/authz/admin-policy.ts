import type { UserRole } from '../../types';

export function adminPath(url: string) {
  const [path] = url.split('?');
  return path.replace(/^\/admin(?=\/|$)/, '') || '/';
}

function isSystemAdminPath(path: string) {
  return path.startsWith('/tenants') || path.startsWith('/queues') || path.startsWith('/storage');
}

export function isPersonalizationAdminPath(path: string) {
  return path.startsWith('/personalized-products') ||
    path.startsWith('/templates') ||
    path.startsWith('/cases') ||
    path.startsWith('/render-jobs') ||
    path.startsWith('/fonts');
}

function operatorWarehouseAccess(method: string, path: string) {
  if (!path.startsWith('/warehouse')) return false;
  if (path.startsWith('/warehouse/catalogs')) return false;

  if (path.startsWith('/warehouse/products')) {
    return method === 'GET';
  }

  if (path === '/warehouse/recalculate-stock') return false;
  if (path.startsWith('/warehouse/price-sync-logs') || path.startsWith('/warehouse/stock-sync-logs')) {
    return method === 'GET';
  }

  return true;
}

export function canAccessAdminPath(role: UserRole, method: string, url: string) {
  const path = adminPath(url);

  if (role === 'SUPER_ADMIN') return true;

  if (role === 'ADMIN') {
    return !isSystemAdminPath(path);
  }

  if (role !== 'OPERATOR') return false;

  if (path === '/' || path.startsWith('/stats')) return method === 'GET';
  if (path.startsWith('/sync-logs')) return method === 'GET';
  if (path.startsWith('/render-jobs')) return true;
  if (path.startsWith('/cases')) return true;
  if (path.startsWith('/orders')) return method !== 'DELETE';

  return operatorWarehouseAccess(method, path);
}
