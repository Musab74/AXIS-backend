import type { Request } from 'express';

/**
 * Normalize loopback and IPv4-mapped IPv6 so comparisons match reverse proxies.
 */
export function normalizeClientIp(ip: string): string {
  const t = ip.trim();
  if (t.startsWith('::ffff:')) return t.slice('::ffff:'.length);
  if (t === '::1') return '127.0.0.1';
  return t;
}

/**
 * Best-effort client IP: first hop of X-Forwarded-For, then Express req.ip / socket.
 * Configure your edge (Apache/Nginx) to append the real client IP to X-Forwarded-For.
 */
export function getRequestClientIp(req: Request): string {
  const xff = req.headers['x-forwarded-for'];
  if (typeof xff === 'string' && xff.length > 0) {
    const first = xff.split(',')[0];
    if (first) return normalizeClientIp(first);
  }
  if (Array.isArray(xff) && xff[0]) {
    const first = xff[0].split(',')[0];
    if (first) return normalizeClientIp(first);
  }
  const raw = req.ip || req.socket.remoteAddress || '';
  return normalizeClientIp(raw);
}
