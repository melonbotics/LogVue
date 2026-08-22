import { EventEmitter } from 'node:events'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { describe, expect, it, vi } from 'vitest'
import {
  SpiderKitSimProtocolClient,
  SpiderKitSimProtocolError
} from '../src/main/services/simulation/protocol'

class FakeReadable extends EventEmitter {
  setEncoding(): void {}
}

class FakeWritable extends EventEmitter {
  destroyed = false
  readonly writes: string[] = []

  write(value: string, _encoding: string, callback: (error?: Error | null) => void): boolean {
    this.writes.push(value)
    callback(null)
    return true
  }

  end(): void {
    this.destroyed = true
  }
}

function fakeChild(): {
  child: ChildProcessWithoutNullStreams
  process: EventEmitter & {
    stdout: FakeReadable
    stderr: FakeReadable
    stdin: FakeWritable
    killed: boolean
    kill: () => boolean
  }
} {
  const process = Object.assign(new EventEmitter(), {
    stdout: new FakeReadable(),
    stderr: new FakeReadable(),
    stdin: new FakeWritable(),
    killed: false,
    kill() {
      this.killed = true
      return true
    }
  })
  return { child: process as unknown as ChildProcessWithoutNullStreams, process }
}

function status() {
  return {
    state: 'PAUSED',
    id: 'test.opmode',
    tick: 0,
    timeSeconds: 0,
    dtSeconds: 0.02,
    rateHz: 50
  }
}

describe('SpiderKit Sim NDJSON protocol', () => {
  it('matches a strict request/reply by id and command', async () => {
    const { child, process } = fakeChild()
    const client = new SpiderKitSimProtocolClient(child)
    const reply = client.request('hello')
    const request = JSON.parse(process.stdin.writes[0])

    expect(request).toEqual({ protocolVersion: 1, id: 1, command: 'hello' })
    process.stdout.emit(
      'data',
      `${JSON.stringify({
        protocol: 'spiderkit-sim-opmode',
        protocolVersion: 1,
        id: 1,
        command: 'hello',
        ok: true,
        status: status()
      })}\n`
    )

    await expect(reply).resolves.toEqual(status())
  })

  it('fails the session on malformed stdout instead of treating it as console output', async () => {
    const { child, process } = fakeChild()
    const fatal = vi.fn()
    const client = new SpiderKitSimProtocolClient(child, fatal)
    const reply = client.request('status')

    process.stdout.emit('data', 'not json\n')

    await expect(reply).rejects.toMatchObject<Partial<SpiderKitSimProtocolError>>({
      code: 'MALFORMED_RESPONSE'
    })
    expect(fatal).toHaveBeenCalledOnce()
    await expect(client.request('status')).rejects.toMatchObject({ code: 'MALFORMED_RESPONSE' })
  })

  it('closes stdin as the independent fail-close boundary', () => {
    const { child, process } = fakeChild()
    const client = new SpiderKitSimProtocolClient(child)

    client.closeInput()
    client.closeInput()

    expect(process.stdin.destroyed).toBe(true)
  })

  it('treats an unknown timed-out request outcome as fatal', async () => {
    const { child } = fakeChild()
    const fatal = vi.fn()
    const client = new SpiderKitSimProtocolClient(child, fatal)

    await expect(client.request('resume', {}, 1)).rejects.toMatchObject({
      code: 'REQUEST_TIMEOUT'
    })
    expect(fatal).toHaveBeenCalledOnce()
    await expect(client.request('status')).rejects.toMatchObject({ code: 'REQUEST_TIMEOUT' })
  })
})
