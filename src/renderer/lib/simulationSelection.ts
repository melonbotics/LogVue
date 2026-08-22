import type { SimulationOpModeInfo } from '@shared/types/simulation'

export interface ProgramSelection {
  pluginId: string
  opModeId: string
}

/** A select-safe, collision-free key for a plugin-owned program. */
export function programSelectionKey(selection: ProgramSelection): string {
  return JSON.stringify([selection.pluginId, selection.opModeId])
}

export function parseProgramSelectionKey(value: string): ProgramSelection | null {
  try {
    const parsed: unknown = JSON.parse(value)
    if (
      !Array.isArray(parsed) ||
      parsed.length !== 2 ||
      typeof parsed[0] !== 'string' ||
      typeof parsed[1] !== 'string' ||
      parsed[0].length === 0 ||
      parsed[1].length === 0
    ) {
      return null
    }
    return { pluginId: parsed[0], opModeId: parsed[1] }
  } catch {
    return null
  }
}

export function programMatches(
  program: SimulationOpModeInfo,
  selection: ProgramSelection | null
): boolean {
  return (
    selection !== null &&
    program.pluginId === selection.pluginId &&
    program.id === selection.opModeId
  )
}

/** Keep an exact selection, resolve a legacy id only when unambiguous, or choose the first program. */
export function reconcileProgramSelection(
  programs: SimulationOpModeInfo[],
  current: ProgramSelection | null
): ProgramSelection | null {
  if (current && programs.some((program) => programMatches(program, current))) return current

  if (current && !current.pluginId) {
    const idMatches = programs.filter(({ id }) => id === current.opModeId)
    if (idMatches.length === 1) return selectionOf(idMatches[0])
    if (idMatches.length > 1) return current
  }

  return programs[0] ? selectionOf(programs[0]) : null
}

export function selectionOf(program: SimulationOpModeInfo): ProgramSelection {
  return { pluginId: program.pluginId, opModeId: program.id }
}

export function parseStoredControllerIndex(value: string | null): number | null {
  if (value === null || !/^\d+$/.test(value)) return null
  const index = Number(value)
  return Number.isSafeInteger(index) ? index : null
}
