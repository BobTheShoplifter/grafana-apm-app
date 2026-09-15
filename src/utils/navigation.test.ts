/**
 * Tests for navigation URL construction.
 *
 * These verify that appNavigate builds valid URLs without double query strings.
 * We test the pure URL-building logic by extracting it from the hook.
 */

import { PLUGIN_BASE_URL } from '../constants';
import { sanitizeParam } from './navigation';

/** Pure function mirroring the URL construction logic in useAppNavigate */
function buildNavigationURL(
  path: string,
  currentParams: Record<string, string>,
  extraParams?: Record<string, string>
): string {
  const PRESERVED_PARAMS = ['from', 'to', 'namespace', 'sort', 'dir', 'q', 'pageSize'];
  const params = new URLSearchParams();
  for (const key of PRESERVED_PARAMS) {
    const raw = currentParams[key];
    const val = raw ? sanitizeParam(raw) : undefined;
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
  return `${PLUGIN_BASE_URL}/${path}${qs ? `?${qs}` : ''}`;
}

describe('buildNavigationURL', () => {
  it('builds URL without query params when none exist', () => {
    const url = buildNavigationURL('services', {});
    expect(url).toBe(`${PLUGIN_BASE_URL}/services`);
    expect(url.match(/\?/g)?.length ?? 0).toBeLessThanOrEqual(1);
  });

  it('preserves from/to params', () => {
    const url = buildNavigationURL('services', { from: '1000', to: '2000' });
    expect(url).toContain('?from=1000&to=2000');
    expect(url.match(/\?/g)?.length).toBe(1);
  });

  it('does NOT carry environment over from the current params', () => {
    // It used to. The effect was a filter nobody chose: one link that happened to know an
    // environment pinned every page after it, with no sign of where the value came from.
    const url = buildNavigationURL('dependencies/foo', { environment: 'prod-fss', from: '1000', to: '2000' });
    expect(url).not.toContain('environment');
    expect(url).toContain('from=1000');
    expect(url.match(/\?/g)?.length).toBe(1);
  });

  it('still sets environment when a link asks for it explicitly', () => {
    // A link that genuinely needs one passes it; only inheritance from the current url stops.
    const url = buildNavigationURL('services/ns/svc', { environment: 'dev-fss' }, { environment: 'prod-fss' });
    expect(url).toContain('environment=prod-fss');
    expect(url).not.toContain('dev-fss');
    expect(url.match(/\?/g)?.length).toBe(1);
  });

  it('never produces double question marks', () => {
    // This was the bug: embedding ?environment=X in path caused double ?
    const url = buildNavigationURL('services/ns/svc', { from: '1000', to: '2000' }, { environment: 'prod' });
    const questionMarks = url.match(/\?/g)?.length ?? 0;
    expect(questionMarks).toBeLessThanOrEqual(1);
  });

  it('does not add empty params', () => {
    const url = buildNavigationURL('services', { namespace: '', environment: '' });
    expect(url).toBe(`${PLUGIN_BASE_URL}/services`);
  });

  it('encodes special characters in param values', () => {
    // Uses `namespace` because it is a preserved param; `environment` no longer is.
    const url = buildNavigationURL('services', { namespace: 'prod gcp' });
    expect(url).toContain('namespace=prod+gcp');
    expect(url.match(/\?/g)?.length).toBe(1);
  });

  it('sanitizes corrupted param values from the old double-? bug', () => {
    // Old bug created URLs like ?namespace=prod-fss?sort=rate
    const url = buildNavigationURL('services', { namespace: 'prod-fss?sort=rate', from: '1000' });
    expect(url).toContain('namespace=prod-fss');
    expect(url).not.toContain('sort=rate');
    expect(url.match(/\?/g)?.length).toBe(1);
  });
});

describe('sanitizeParam', () => {
  it('returns clean values unchanged', () => {
    expect(sanitizeParam('prod-fss')).toBe('prod-fss');
    expect(sanitizeParam('')).toBe('');
    expect(sanitizeParam('dev-gcp')).toBe('dev-gcp');
  });

  it('strips corrupted query string from values', () => {
    expect(sanitizeParam('prod-fss?sort=rate')).toBe('prod-fss');
    expect(sanitizeParam('dev-gcp?dir=desc&page=2')).toBe('dev-gcp');
  });

  it('handles value that is just a question mark', () => {
    expect(sanitizeParam('?')).toBe('');
  });
});
