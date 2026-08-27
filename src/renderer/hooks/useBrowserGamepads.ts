import { useEffect, useMemo, useRef, useState } from 'react'
import type { SimulationGamepadSnapshot } from '@shared/types/simulation'

export interface BrowserController {
  index: number
  id: string
  mapping: GamepadMappingType
  connected: boolean
}

const DEADZONE = 0.04

function axis(value: number | undefined): number {
  if (!Number.isFinite(value) || Math.abs(value ?? 0) < DEADZONE) return 0
  return Math.max(-1, Math.min(1, value ?? 0))
}

function trigger(button: GamepadButton | undefined): number {
  if (!button || !Number.isFinite(button.value)) return 0
  return Math.max(0, Math.min(1, button.value))
}

function pressed(button: GamepadButton | undefined): boolean {
  return !!button?.pressed
}

/** A disconnected LIVE source is deliberately represented as a full neutral frame. */
export function neutralBrowserGamepad(capturedAt = performance.now()): SimulationGamepadSnapshot {
  return {
    connected: false,
    id: null,
    mapping: '',
    index: null,
    timestamp: 0,
    capturedAt,
    axes: {
      leftStickX: 0,
      leftStickY: 0,
      rightStickX: 0,
      rightStickY: 0,
      leftTrigger: 0,
      rightTrigger: 0
    },
    buttons: {
      a: false,
      b: false,
      x: false,
      y: false,
      dpadUp: false,
      dpadDown: false,
      dpadLeft: false,
      dpadRight: false,
      leftBumper: false,
      rightBumper: false,
      leftStickButton: false,
      rightStickButton: false,
      back: false,
      start: false,
      guide: false,
      touchpad: false
    }
  }
}

export function readBrowserGamepad(index: number | null): SimulationGamepadSnapshot {
  const capturedAt = performance.now()
  if (index === null || typeof navigator.getGamepads !== 'function') {
    return neutralBrowserGamepad(capturedAt)
  }

  const gamepad = navigator.getGamepads()[index]
  if (!gamepad?.connected || gamepad.mapping !== 'standard') {
    return neutralBrowserGamepad(capturedAt)
  }

  const { axes, buttons } = gamepad
  return {
    connected: true,
    id: gamepad.id,
    mapping: gamepad.mapping,
    index: gamepad.index,
    timestamp: gamepad.timestamp,
    capturedAt,
    axes: {
      leftStickX: axis(axes[0]),
      leftStickY: axis(axes[1]),
      rightStickX: axis(axes[2]),
      rightStickY: axis(axes[3]),
      leftTrigger: trigger(buttons[6]),
      rightTrigger: trigger(buttons[7])
    },
    buttons: {
      a: pressed(buttons[0]),
      b: pressed(buttons[1]),
      x: pressed(buttons[2]),
      y: pressed(buttons[3]),
      leftBumper: pressed(buttons[4]),
      rightBumper: pressed(buttons[5]),
      back: pressed(buttons[8]),
      start: pressed(buttons[9]),
      leftStickButton: pressed(buttons[10]),
      rightStickButton: pressed(buttons[11]),
      dpadUp: pressed(buttons[12]),
      dpadDown: pressed(buttons[13]),
      dpadLeft: pressed(buttons[14]),
      dpadRight: pressed(buttons[15]),
      guide: pressed(buttons[16]),
      touchpad: pressed(buttons[17])
    }
  }
}

function listControllers(): BrowserController[] {
  if (typeof navigator.getGamepads !== 'function') return []
  return Array.from(navigator.getGamepads())
    .filter((gamepad): gamepad is Gamepad => !!gamepad?.connected)
    .map(({ index, id, mapping, connected }) => ({ index, id, mapping, connected }))
}

function controllerSignature(controllers: BrowserController[]): string {
  return controllers.map(({ index, id, mapping }) => `${index}:${id}:${mapping}`).join('|')
}

/**
 * Chromium may keep the list empty until the user presses a button. Polling also
 * catches reconnects on platforms that do not reliably emit GamepadEvents.
 */
export function useBrowserControllers(): {
  controllers: BrowserController[]
  lastActivatedIndex: number | null
  supported: boolean
} {
  const supported = typeof navigator.getGamepads === 'function'
  const [controllers, setControllers] = useState<BrowserController[]>(() => listControllers())
  const [lastActivatedIndex, setLastActivatedIndex] = useState<number | null>(null)
  const signatureRef = useRef(controllerSignature(controllers))
  const buttonStateRef = useRef(new Map<number, boolean>())

  useEffect(() => {
    if (!supported) return

    const refresh = (): void => {
      const next = listControllers()
      const signature = controllerSignature(next)
      if (signature !== signatureRef.current) {
        signatureRef.current = signature
        setControllers(next)
      }

      for (const controller of next) {
        const gamepad = navigator.getGamepads()[controller.index]
        const anyPressed = gamepad?.buttons.some((button) => button.pressed) ?? false
        if (anyPressed && !buttonStateRef.current.get(controller.index)) {
          setLastActivatedIndex(controller.index)
        }
        buttonStateRef.current.set(controller.index, anyPressed)
      }
    }

    const timer = window.setInterval(refresh, 200)
    window.addEventListener('gamepadconnected', refresh)
    window.addEventListener('gamepaddisconnected', refresh)
    refresh()
    return () => {
      window.clearInterval(timer)
      window.removeEventListener('gamepadconnected', refresh)
      window.removeEventListener('gamepaddisconnected', refresh)
    }
  }, [supported])

  return useMemo(
    () => ({ controllers, lastActivatedIndex, supported }),
    [controllers, lastActivatedIndex, supported]
  )
}
