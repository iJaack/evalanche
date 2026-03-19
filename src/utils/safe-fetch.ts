import { EvalancheError, EvalancheErrorCode } from './errors';

export interface SafeFetchOptions extends RequestInit {
  timeoutMs?: number;
  maxBytes?: number;
  allowHttp?: boolean;
  blockPrivateNetwork?: boolean;
}

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_BYTES = 1_000_000;
const PRIVATE_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

function isPrivateIpv4(hostname: string): boolean {
  const parts = hostname.split('.').map(Number);
  if (parts.length !== 4 || parts.some((n) => Number.isNaN(n) || n < 0 || n > 255)) return false;
  const [a, b] = parts;
  return a === 10
    || a === 127
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168);
}

function isBlockedHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  return PRIVATE_HOSTS.has(normalized)
    || normalized.endsWith('.local')
    || isPrivateIpv4(normalized)
    || normalized === '0.0.0.0';
}

export function assertSafeUrl(url: string | URL, opts: Pick<SafeFetchOptions, 'allowHttp' | 'blockPrivateNetwork'> = {}): URL {
  const parsed = typeof url === 'string' ? new URL(url) : url;
  const allowHttp = opts.allowHttp ?? false;
  const blockPrivateNetwork = opts.blockPrivateNetwork ?? false;

  if (parsed.protocol !== 'https:' && !(allowHttp && parsed.protocol === 'http:')) {
    throw new EvalancheError(
      `Unsupported URL protocol: ${parsed.protocol}`,
      EvalancheErrorCode.NETWORK_ERROR,
    );
  }

  if (blockPrivateNetwork && isBlockedHostname(parsed.hostname)) {
    throw new EvalancheError(
      `Blocked private or loopback target: ${parsed.hostname}`,
      EvalancheErrorCode.NETWORK_ERROR,
    );
  }

  return parsed;
}

export async function safeFetch(url: string | URL, options: SafeFetchOptions = {}): Promise<Response> {
  const parsed = assertSafeUrl(url, options);
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(parsed.toString(), {
      ...options,
      redirect: options.redirect ?? 'error',
      signal: controller.signal,
    });

    const contentLength = typeof response.headers?.get === 'function'
      ? response.headers.get('content-length')
      : null;
    const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
    if (contentLength && Number(contentLength) > maxBytes) {
      throw new EvalancheError(
        `Response too large: ${contentLength} bytes exceeds max ${maxBytes}`,
        EvalancheErrorCode.NETWORK_ERROR,
      );
    }

    return response;
  } catch (error) {
    if (error instanceof EvalancheError) throw error;
    const reason = error instanceof Error ? error.message : String(error);
    throw new EvalancheError(
      `Network request failed: ${reason}`,
      EvalancheErrorCode.NETWORK_ERROR,
      error instanceof Error ? error : undefined,
    );
  } finally {
    clearTimeout(timeout);
  }
}
