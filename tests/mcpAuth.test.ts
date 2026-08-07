import { describe, expect, it } from 'vitest'
import { createMcpBearerToken, isAuthorizedMcpRequest } from '../src/main/mcp/auth'

const TOKEN = 'test-token-that-is-at-least-32-characters-long'
const AUTHORIZATION = `Bearer ${TOKEN}`

describe('MCP HTTP authorization', () => {
  it('mints a fresh 256-bit credential for each process launch', () => {
    const first = createMcpBearerToken()
    const second = createMcpBearerToken()
    expect(Buffer.from(first, 'base64url')).toHaveLength(32)
    expect(Buffer.from(second, 'base64url')).toHaveLength(32)
    expect(second).not.toBe(first)
  })

  it.each(['127.0.0.1', '::1', '::ffff:127.0.0.1'])(
    'requires the bearer credential from loopback address %s',
    (address) => {
      expect(isAuthorizedMcpRequest(address, undefined, undefined, TOKEN)).toBe(false)
      expect(isAuthorizedMcpRequest(address, undefined, 'Bearer wrong-token', TOKEN)).toBe(false)
      expect(isAuthorizedMcpRequest(address, undefined, AUTHORIZATION, TOKEN)).toBe(true)
    }
  )

  it('accepts only loopback Origin hosts from a loopback peer', () => {
    expect(isAuthorizedMcpRequest('127.0.0.1', 'http://localhost:3000', AUTHORIZATION, TOKEN)).toBe(true)
    expect(isAuthorizedMcpRequest('::1', 'http://[::1]:3000', AUTHORIZATION, TOKEN)).toBe(true)
    expect(isAuthorizedMcpRequest('127.0.0.1', 'https://attacker.example', AUTHORIZATION, TOKEN)).toBe(false)
    expect(isAuthorizedMcpRequest('127.0.0.1', 'not a URL', AUTHORIZATION, TOKEN)).toBe(false)
  })

  it('allows an authenticated non-loopback WSL peer only without an Origin header', () => {
    expect(isAuthorizedMcpRequest('172.24.64.1', undefined, AUTHORIZATION, TOKEN)).toBe(true)
    expect(isAuthorizedMcpRequest('172.24.64.1', 'http://localhost:3000', AUTHORIZATION, TOKEN)).toBe(false)
    expect(isAuthorizedMcpRequest('172.24.64.1', undefined, undefined, TOKEN)).toBe(false)
  })

  it('fails closed when the server credential is unavailable', () => {
    expect(isAuthorizedMcpRequest('127.0.0.1', undefined, AUTHORIZATION, null)).toBe(false)
  })
})
