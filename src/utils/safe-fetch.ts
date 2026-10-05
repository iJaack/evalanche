import { EvalancheError, EvalancheErrorCode } from './errors';

export interface SafeFetchOptions extends RequestInit {
  /** Total deadline for receiving headers and consuming the response body. */
  timeoutMs?: number;
  maxBytes?: number;
  allowHttp?: boolean;
  blockPrivateNetwork?: boolean;
}

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_BYTES = 1_000_000;
const PRIVATE_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

function createTooLargeError(actualBytes: number, maxBytes: number): EvalancheError {
  return new EvalancheError(
    `Response too large: ${actualBytes} bytes exceeds max ${maxBytes}`,
    EvalancheErrorCode.NETWORK_ERROR,
  );
}

function networkError(error: unknown): EvalancheError {
  if (error instanceof EvalancheError) return error;
  const reason = error instanceof Error ? error.message : String(error);
  return new EvalancheError(
    `Network request failed: ${reason}`,
    EvalancheErrorCode.NETWORK_ERROR,
    error instanceof Error ? error : undefined,
  );
}

function wrapResponseWithBodyLimit(response: Response, maxBytes: number, cleanup: () => void): Response {
  const originalArrayBuffer = typeof response.arrayBuffer === 'function'
    ? response.arrayBuffer.bind(response)
    : null;
  const originalText = typeof response.text === 'function'
    ? response.text.bind(response)
    : null;
  const originalJson = typeof response.json === 'function'
    ? response.json.bind(response)
    : null;
  let bytesPromise: Promise<Uint8Array> | null = null;

  const readBytes = async (): Promise<Uint8Array> => {
    if (bytesPromise) return bytesPromise;

    bytesPromise = (async () => {
      try {
        if (!response.body) {
          if (originalArrayBuffer) {
            const bytes = new Uint8Array(await originalArrayBuffer());
            if (bytes.byteLength > maxBytes) throw createTooLargeError(bytes.byteLength, maxBytes);
            return bytes;
          }

          if (originalText) {
            const text = await originalText();
            const bytes = new TextEncoder().encode(text);
            if (bytes.byteLength > maxBytes) throw createTooLargeError(bytes.byteLength, maxBytes);
            return bytes;
          }

          if (originalJson) {
            const jsonValue = await originalJson();
            const bytes = new TextEncoder().encode(JSON.stringify(jsonValue));
            if (bytes.byteLength > maxBytes) throw createTooLargeError(bytes.byteLength, maxBytes);
            return bytes;
          }

          return new Uint8Array();
        }

        const reader = response.body.getReader();
        const chunks: Uint8Array[] = [];
        let total = 0;

        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            const chunk = value instanceof Uint8Array ? value : new Uint8Array(value);
            total += chunk.byteLength;
            if (total > maxBytes) throw createTooLargeError(total, maxBytes);
            chunks.push(chunk);
          }
        } catch (error) {
          await reader.cancel().catch(() => undefined);
          throw error;
        } finally {
          reader.releaseLock();
        }

        const combined = new Uint8Array(total);
        let offset = 0;
        for (const chunk of chunks) {
          combined.set(chunk, offset);
          offset += chunk.byteLength;
        }
        return combined;
      } catch (error) {
        throw networkError(error);
      } finally {
        cleanup();
      }
    })();

    return bytesPromise;
  };

  return new Proxy(response, {
    get(target, prop, receiver) {
      if (prop === 'arrayBuffer') {
        return async () => {
          const bytes = await readBytes();
          return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
        };
      }
      if (prop === 'text') {
        return async () => {
          const bytes = await readBytes();
          return new TextDecoder().decode(bytes);
        };
      }
      if (prop === 'json') {
        return async () => JSON.parse(await (receiver as Response).text()) as unknown;
      }
      if (prop === 'blob') {
        return async () => {
          const bytes = await readBytes();
          return new Blob([Uint8Array.from(bytes)]);
        };
      }

      const value = Reflect.get(target, prop, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  }) as Response;
}

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
  const { timeoutMs = DEFAULT_TIMEOUT_MS, maxBytes = DEFAULT_MAX_BYTES,
    allowHttp: _allowHttp, blockPrivateNetwork: _blockPrivateNetwork, signal, ...requestOptions } = options;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2_147_483_647 ||
      !Number.isSafeInteger(maxBytes) || maxBytes < 1) {
    throw new EvalancheError('timeoutMs and maxBytes must be positive integers within supported limits', EvalancheErrorCode.INVALID_PARAMS);
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => { controller.abort(); cleanup(); }, timeoutMs);
  // An unread response must not keep a Node process alive just for its deadline.
  timeout.unref?.();
  const onAbort = () => { controller.abort(signal?.reason); cleanup(); };
  const cleanup = () => {
    clearTimeout(timeout);
    signal?.removeEventListener('abort', onAbort);
  };
  signal?.addEventListener('abort', onAbort, { once: true });
  if (signal?.aborted) onAbort();

  try {
    const response = await fetch(parsed.toString(), {
      ...requestOptions,
      redirect: requestOptions.redirect ?? 'error',
      signal: controller.signal,
    });

    const contentLength = typeof response.headers?.get === 'function'
      ? response.headers.get('content-length')
      : null;
    if (contentLength && Number(contentLength) > maxBytes) {
      await response.body?.cancel().catch(() => undefined);
      throw createTooLargeError(Number(contentLength), maxBytes);
    }

    if (!response.body) cleanup();
    return wrapResponseWithBodyLimit(response, maxBytes, cleanup);
  } catch (error) {
    cleanup();
    throw networkError(error);
  }
}
