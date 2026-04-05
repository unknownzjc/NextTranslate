const INJECTABLE_PROTOCOLS = new Set(['http:', 'https:']);
const TWO_PART_TLDS = new Set(['co.uk', 'co.jp', 'com.au', 'co.kr', 'co.in', 'com.br', 'co.nz']);
const IPV4_RE = /^(\d{1,3}\.){3}\d{1,3}$/;

function normalizeHostname(hostname: string): string {
  return hostname.trim().toLowerCase().replace(/\.+$/, '').replace(/^www\./, '');
}

export function isInjectablePageUrl(url?: string | null): boolean {
  if (!url) return false;

  try {
    const parsed = new URL(url);
    return INJECTABLE_PROTOCOLS.has(parsed.protocol);
  } catch {
    return false;
  }
}

export function getMainDomain(hostname: string): string {
  const host = normalizeHostname(hostname);
  if (!host) return '';

  if (host === 'twitter.com' || host === 'x.com') return 'x.com';
  if (host === 'localhost' || IPV4_RE.test(host) || host.includes(':')) return host;

  const parts = host.split('.').filter(Boolean);
  if (parts.length <= 2) {
    return parts.join('.');
  }

  const lastTwo = parts.slice(-2).join('.');
  if (TWO_PART_TLDS.has(lastTwo) && parts.length >= 3) {
    return parts.slice(-3).join('.');
  }

  return parts.slice(-2).join('.');
}

export function getSiteKeyFromHostname(hostname: string): string | null {
  const siteKey = getMainDomain(hostname);
  return siteKey || null;
}

export function getSiteKeyFromUrl(url?: string | null): string | null {
  if (!isInjectablePageUrl(url) || !url) {
    return null;
  }

  try {
    return getSiteKeyFromHostname(new URL(url).hostname);
  } catch {
    return null;
  }
}
