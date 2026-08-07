import { randomBytes, timingSafeEqual } from 'node:crypto'

/** A process-scoped 256-bit credential; it is never recovered from user or archive content. */
export function createMcpBearerToken(): string {
  return randomBytes(32).toString('base64url')
}

function isLoopbackAddress(remoteAddress: string | undefined): boolean {
  return (
    remoteAddress === '127.0.0.1' ||
    remoteAddress === '::1' ||
    remoteAddress === '::ffff:127.0.0.1'
  )
}

function isLoopbackHostname(origin: string): boolean {
  try {
    return ['127.0.0.1', 'localhost', '[::1]'].includes(new URL(origin).hostname)
  } catch {
    return false
  }
}

/**
 * Require the private discovery-file credential on every transport path. Browser
 * origins remain limited to loopback, while non-loopback WSL clients must not
 * send an Origin header.
 */
export function isAuthorizedMcpRequest(
  remoteAddress: string | undefined,
  originHeader: string | undefined,
  authorizationHeader: string | undefined,
  expectedBearerToken: string | null
): boolean {
  const loopback = isLoopbackAddress(remoteAddress)
  if (loopback ? !!originHeader && !isLoopbackHostname(originHeader) : !!originHeader) return false
  if (!expectedBearerToken) return false

  const supplied = authorizationHeader?.match(/^Bearer (.+)$/i)?.[1]
  if (!supplied) return false
  const actual = Buffer.from(expectedBearerToken)
  const candidate = Buffer.from(supplied)
  return actual.length === candidate.length && timingSafeEqual(actual, candidate)
}
