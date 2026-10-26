/**
 * Socket-level codes of a request that never got a response because the network or the host could not be reached
 * (REQ-LINEAR-40): no route, no DNS, connect timeout or refusal, or a socket that dies again after the REQ-LINEAR-36
 * retries. An HTTP or GraphQL error is a response, never one of these.
 */
const UNREACHABLE = new Set([
  'ETIMEDOUT',
  'EHOSTUNREACH',
  'EHOSTDOWN',
  'ENETUNREACH',
  'ENETDOWN',
  'ENOTFOUND',
  'EAI_AGAIN',
  'ECONNREFUSED',
  'ECONNRESET',
  'EPIPE',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_SOCKET',
  'UND_ERR_CLOSED',
]);

/**
 * `{ host, code }` when `e` is Node fetch's `TypeError: fetch failed` caused by an unreachable network (REQ-LINEAR-40),
 * else null. The cause is the socket error, or an AggregateError of one per address tried (IPv4 and IPv6).
 */
export function networkFailure(e) {
  if (!(e instanceof TypeError) || e.message !== 'fetch failed') return null;
  const cause = e.cause;
  if (!UNREACHABLE.has(cause?.code)) return null;
  const host = cause.hostname ?? cause.address ?? cause.errors?.find((x) => x?.address)?.address ?? 'unknown host';
  return { host, code: cause.code };
}
