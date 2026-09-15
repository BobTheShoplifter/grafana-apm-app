import { useCallback } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { PLUGIN_BASE_URL } from '../constants';

/**
 * Query params that are preserved across navigation.
 *
 * `environment` is NOT one of them, deliberately. It used to be, and the effect was that the
 * moment any link set it - following a service row out of an inventory that happens to know
 * one - every subsequent page inherited that filter and kept it, with no indication of where
 * it came from. The default is "All environments"; it should take a deliberate act to leave
 * it, and a deliberate act to come back. A filter you did not choose and cannot see the origin
 * of is worse than no filter.
 *
 * A link that genuinely needs an environment still carries it explicitly in its own href; this
 * list only governs what is inherited from the CURRENT url.
 */
const PRESERVED_PARAMS = [
  'from',
  'to',
  'namespace',
  'sdk',
  'sort',
  'dir',
  'q',
  'pageSize',
  'percentile',
  'favorites',
  'hasErrors',
];

/**
 * Sanitize a query param value that may have been corrupted by the old
 * double-query-string bug (e.g., "prod-fss?sort=rate" → "prod-fss").
 */
export function sanitizeParam(value: string): string {
  const idx = value.indexOf('?');
  return idx >= 0 ? value.substring(0, idx) : value;
}

/**
 * Navigation hook that preserves time range and filter params across pages.
 * Carries: from, to, namespace. NOT environment - see PRESERVED_PARAMS.
 */
export function useAppNavigate() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();

  const appNavigate = useCallback(
    (path: string, extraParams?: Record<string, string>) => {
      const params = new URLSearchParams();
      for (const key of PRESERVED_PARAMS) {
        const raw = searchParams.get(key);
        const val = raw ? sanitizeParam(raw) : null;
        if (val) {
          params.set(key, val);
        }
      }
      if (extraParams) {
        for (const [k, v] of Object.entries(extraParams)) {
          if (v) {
            params.set(k, v);
          }
        }
      }
      const qs = params.toString();
      navigate(`${PLUGIN_BASE_URL}/${path}${qs ? `?${qs}` : ''}`);
    },
    [navigate, searchParams]
  );

  return appNavigate;
}
