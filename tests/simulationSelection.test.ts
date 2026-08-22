import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SimulationOpModeInfo } from '../src/shared/types/simulation'
import { readBrowserGamepad } from '../src/renderer/hooks/useBrowserGamepads'
import {
  parseProgramSelectionKey,
  parseStoredControllerIndex,
  programMatches,
  programSelectionKey,
  reconcileProgramSelection
} from '../src/renderer/lib/simulationSelection'

const programs: SimulationOpModeInfo[] = [
  { id: 'teleop', name: 'TeleOp', group: '', type: 'TELEOP', pluginId: 'alpha' },
  { id: 'teleop', name: 'TeleOp', group: '', type: 'TELEOP', pluginId: 'beta' }
]

afterEach(() => vi.unstubAllGlobals())

describe('simulation program selection', () => {
  it('round trips plugin and program IDs without collisions', () => {
    const alpha = programSelectionKey({ pluginId: 'alpha:beta', opModeId: 'teleop' })
    const beta = programSelectionKey({ pluginId: 'alpha', opModeId: 'beta:teleop' })

    expect(alpha).not.toBe(beta)
    expect(parseProgramSelectionKey(alpha)).toEqual({ pluginId: 'alpha:beta', opModeId: 'teleop' })
  })

  it('keeps duplicate program IDs distinct by plugin', () => {
    const selection = { pluginId: 'beta', opModeId: 'teleop' }

    expect(programs.filter((program) => programMatches(program, selection))).toEqual([programs[1]])
    expect(reconcileProgramSelection(programs, selection)).toEqual(selection)
  })

  it('does not guess a plugin for an ambiguous legacy program ID', () => {
    expect(reconcileProgramSelection(programs, { pluginId: '', opModeId: 'teleop' })).toEqual({
      pluginId: '',
      opModeId: 'teleop'
    })
  })
})

describe('stored controller selection', () => {
  it('accepts only non-negative integer browser indices', () => {
    expect(parseStoredControllerIndex('0')).toBe(0)
    expect(parseStoredControllerIndex('12')).toBe(12)
    expect(parseStoredControllerIndex(null)).toBeNull()
    expect(parseStoredControllerIndex('-1')).toBeNull()
    expect(parseStoredControllerIndex('1.5')).toBeNull()
  })

  it('publishes a complete neutral frame while the selected controller is disconnected', () => {
    vi.stubGlobal('navigator', { getGamepads: () => [] })

    expect(readBrowserGamepad(3)).toMatchObject({
      connected: false,
      index: null,
      axes: {
        leftStickX: 0,
        leftStickY: 0,
        rightStickX: 0,
        rightStickY: 0,
        leftTrigger: 0,
        rightTrigger: 0
      },
      buttons: { a: false, b: false, start: false }
    })
  })
})
