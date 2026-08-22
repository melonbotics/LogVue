import { useCallback, useEffect, useRef, useState } from 'react'
import type {
  SimulationCatalog,
  SimulationGamepadRuntimeStatus,
  SimulationGamepadSource,
  SimulationProject,
  SimulationRunnerStatus,
  SimulationStatus
} from '@shared/types/simulation'
import { api } from '../api/client'
import {
  readBrowserGamepad,
  useBrowserControllers,
  type BrowserController
} from '../hooks/useBrowserGamepads'
import {
  parseProgramSelectionKey,
  parseStoredControllerIndex,
  programMatches,
  programSelectionKey,
  reconcileProgramSelection,
  type ProgramSelection
} from '../lib/simulationSelection'

const DEFAULT_RATE_HZ = 50
const DEFAULT_STALE_MS = 250
const DEFAULT_RLOG_PORT = '5800'
const EMPTY_CATALOG: SimulationCatalog = { plugins: [], opModes: [], scenarios: [] }
const CONTROLLER_1_STORAGE_KEY = 'logvue.sim.controller1'
const CONTROLLER_2_STORAGE_KEY = 'logvue.sim.controller2'

type Slot = 1 | 2

export default function SimulateWorkspace(): JSX.Element {
  const [status, setStatus] = useState<SimulationStatus | null>(null)
  const [projectDirectory, setProjectDirectory] = useState(
    () => globalThis.localStorage?.getItem('logvue.sim.project') ?? ''
  )
  const [project, setProject] = useState<SimulationProject | null>(null)
  const [catalog, setCatalog] = useState<SimulationCatalog>(EMPTY_CATALOG)
  const [selectedProgram, setSelectedProgram] = useState<ProgramSelection | null>(null)
  const [scenarioId, setScenarioId] = useState('')
  const [gamepad1Source, setGamepad1Source] = useState<SimulationGamepadSource>({ kind: 'NONE' })
  const [gamepad2Source, setGamepad2Source] = useState<SimulationGamepadSource>({ kind: 'NONE' })
  const [controller1, setController1] = useState<number | null>(() =>
    parseStoredControllerIndex(globalThis.localStorage?.getItem(CONTROLLER_1_STORAGE_KEY) ?? null)
  )
  const [controller2, setController2] = useState<number | null>(() =>
    parseStoredControllerIndex(globalThis.localStorage?.getItem(CONTROLLER_2_STORAGE_KEY) ?? null)
  )
  const [startPaused, setStartPaused] = useState(true)
  const [fastDuration, setFastDuration] = useState(
    () => globalThis.localStorage?.getItem('logvue.sim.fastDuration') ?? '1.0'
  )
  const [rateHz, setRateHz] = useState(
    () => globalThis.localStorage?.getItem('logvue.sim.rateHz') ?? String(DEFAULT_RATE_HZ)
  )
  const [rlogPort, setRlogPort] = useState(
    () => globalThis.localStorage?.getItem('logvue.sim.rlogPort') ?? DEFAULT_RLOG_PORT
  )
  const [busy, setBusy] = useState<string | null>(null)
  const [localError, setLocalError] = useState<string | null>(null)
  const hydratedPid = useRef<number | null>(null)
  const catalogHydratedPid = useRef<number | null>(null)
  const { controllers, lastActivatedIndex, supported: gamepadsSupported } = useBrowserControllers()

  const phase = status?.phase ?? 'idle'
  const sessionActive = Boolean(status?.pid)
    || ['starting', 'running', 'paused', 'stopping'].includes(phase)
  const configLocked = sessionActive

  const acceptCatalog = useCallback((discovered: SimulationCatalog) => {
    setCatalog(discovered)
    setScenarioId('')
    setSelectedProgram((current) => reconcileProgramSelection(discovered.opModes, current))
  }, [])

  const loadProject = useCallback(async (directory: string, refreshCatalog = true) => {
    if (!directory) return
    setBusy('discover')
    setLocalError(null)
    try {
      const discovered = await api.simulation.discoverProject(directory)
      setProject(discovered)
      setProjectDirectory(discovered.projectDirectory)
      globalThis.localStorage?.setItem('logvue.sim.project', discovered.projectDirectory)
      if (refreshCatalog) {
        try {
          const discoveredCatalog = await api.simulation.listCatalog(discovered.projectDirectory)
          acceptCatalog(discoveredCatalog)
        } catch (error) {
          setCatalog(EMPTY_CATALOG)
          setSelectedProgram(null)
          setScenarioId('')
          setLocalError(
            discovered.buildAvailable
              ? `Catalog unavailable. Build the robot project, then refresh. ${messageOf(error)}`
              : messageOf(error)
          )
        }
      }
    } catch (error) {
      setProject(null)
      setCatalog(EMPTY_CATALOG)
      setSelectedProgram(null)
      setScenarioId('')
      setLocalError(messageOf(error))
    } finally {
      setBusy(null)
    }
  }, [acceptCatalog])

  useEffect(() => {
    let alive = true
    api.simulation
      .getStatus()
      .then((next) => alive && setStatus(next))
      .catch((error) => alive && setLocalError(messageOf(error)))
    const unsubscribe = api.simulation.onStatus((next) => setStatus(next))
    return () => {
      alive = false
      unsubscribe()
    }
  }, [])

  useEffect(() => {
    if (!projectDirectory || project || sessionActive) return
    void loadProject(projectDirectory)
  }, [loadProject, project, projectDirectory, sessionActive])

  // Recover immutable setup after renderer reload while the main-owned sim-cli is still running.
  useEffect(() => {
    if (!status?.pid || !status.config || hydratedPid.current === status.pid) return
    hydratedPid.current = status.pid
    setGamepad1Source(status.config.gamepad1)
    setGamepad2Source(status.config.gamepad2)
    setStartPaused(status.config.startPaused ?? false)
    setRateHz(String(status.config.rateHz ?? DEFAULT_RATE_HZ))
    setRlogPort(String(status.config.rlogPort ?? Number(DEFAULT_RLOG_PORT)))
    setSelectedProgram({
      pluginId: status.config.pluginId ?? '',
      opModeId: status.config.opModeId
    })
    setScenarioId(status.config.scenarioId ?? '')
    if (status.project) {
      setProject(status.project)
      setProjectDirectory(status.project.projectDirectory)
    }
  }, [status])

  useEffect(() => {
    globalThis.localStorage?.setItem('logvue.sim.fastDuration', fastDuration)
  }, [fastDuration])

  useEffect(() => {
    const value = Number(rateHz)
    if (Number.isFinite(value) && value >= 1 && value <= 1000) {
      globalThis.localStorage?.setItem('logvue.sim.rateHz', rateHz)
    }
  }, [rateHz])

  useEffect(() => {
    if (
      !status?.pid ||
      !status.project ||
      catalog.opModes.length > 0 ||
      catalogHydratedPid.current === status.pid
    ) return
    catalogHydratedPid.current = status.pid
    let alive = true
    api.simulation
      .listCatalog(status.project.projectDirectory)
      .then((discovered) => {
        if (!alive) return
        setCatalog(discovered)
        setSelectedProgram((current) => reconcileProgramSelection(discovered.opModes, current))
      })
      .catch((error) => alive && setLocalError(messageOf(error)))
    return () => {
      alive = false
    }
  }, [catalog.opModes.length, status?.pid, status?.project])

  useEffect(() => {
    if (validRlogPort(rlogPort)) {
      globalThis.localStorage?.setItem('logvue.sim.rlogPort', rlogPort)
    }
  }, [rlogPort])

  useEffect(() => {
    persistControllerIndex(CONTROLLER_1_STORAGE_KEY, controller1)
  }, [controller1])

  useEffect(() => {
    persistControllerIndex(CONTROLLER_2_STORAGE_KEY, controller2)
  }, [controller2])

  useEffect(() => {
    if (lastActivatedIndex === null) return
    const candidate = controllers.find(
      ({ index, mapping }) => index === lastActivatedIndex && mapping === 'standard'
    )
    if (!candidate) return
    if (gamepad1Source.kind === 'LIVE' && controller1 === null) {
      setController1(candidate.index)
    } else if (
      gamepad2Source.kind === 'LIVE' &&
      controller2 === null &&
      controller1 !== candidate.index
    ) {
      setController2(candidate.index)
    }
  }, [controller1, controller2, controllers, gamepad1Source.kind, gamepad2Source.kind, lastActivatedIndex])

  const publishGamepad1 = sessionActive && status?.config?.gamepad1.kind === 'LIVE'
  const publishGamepad2 = sessionActive && status?.config?.gamepad2.kind === 'LIVE'
  useEffect(() => {
    if (!publishGamepad1 && !publishGamepad2) return
    let animationFrame = 0
    const publish = (): void => {
      api.simulation.publishGamepads({
        gamepad1: publishGamepad1 ? readBrowserGamepad(controller1) : undefined,
        gamepad2: publishGamepad2 ? readBrowserGamepad(controller2) : undefined
      })
      animationFrame = window.requestAnimationFrame(publish)
    }
    publish()
    return () => window.cancelAnimationFrame(animationFrame)
  }, [controller1, controller2, publishGamepad1, publishGamepad2])

  const chooseProject = async (): Promise<void> => {
    setBusy('pick-project')
    setLocalError(null)
    try {
      const selected = await api.simulation.pickProject()
      if (selected) await loadProject(selected)
    } catch (error) {
      setLocalError(messageOf(error))
    } finally {
      setBusy(null)
    }
  }

  const buildProject = async (): Promise<void> => {
    if (!projectDirectory) return
    setBusy('build')
    setLocalError(null)
    try {
      const result = await api.simulation.buildProject(projectDirectory)
      setProject(result.project)
      acceptCatalog(result.catalog)
    } catch (error) {
      setLocalError(messageOf(error))
    } finally {
      setBusy(null)
    }
  }

  const refreshCatalog = async (): Promise<void> => {
    if (!projectDirectory) return
    setBusy('refresh')
    setLocalError(null)
    try {
      const discoveredCatalog = await api.simulation.listCatalog(projectDirectory)
      acceptCatalog(discoveredCatalog)
    } catch (error) {
      setLocalError(messageOf(error))
    } finally {
      setBusy(null)
    }
  }

  const chooseRlog = async (slot: Slot): Promise<void> => {
    setLocalError(null)
    try {
      const path = await api.simulation.pickRlog()
      if (!path) return
      if (slot === 1) setGamepad1Source({ kind: 'RLOG', path })
      else setGamepad2Source({ kind: 'RLOG', path })
    } catch (error) {
      setLocalError(messageOf(error))
    }
  }

  const startSession = async (): Promise<void> => {
    const requestedRateHz = Number(rateHz)
    if (!Number.isFinite(requestedRateHz) || requestedRateHz < 1 || requestedRateHz > 1000) {
      setLocalError('Update rate must be from 1 to 1000 Hz.')
      return
    }
    const selected = catalog.opModes.find((program) => programMatches(program, selectedProgram))
    const validationError = validateSetup({
      project,
      programSelected: selected !== undefined,
      gamepad1Source,
      gamepad2Source,
      controller1,
      controller2,
      controllers,
      rlogPort
    })
    if (validationError) {
      setLocalError(validationError)
      return
    }
    if (!project || !selected) return
    setBusy('start')
    setLocalError(null)
    try {
      setStatus(
        await api.simulation.start({
          projectDirectory: project.projectDirectory,
          opModeId: selected.id,
          pluginId: selected.pluginId,
          scenarioId: scenarioId || undefined,
          gamepad1: gamepad1Source,
          gamepad2: gamepad2Source,
          rateHz: requestedRateHz,
          staleMs: DEFAULT_STALE_MS,
          rlogPort: Number(rlogPort),
          startPaused
        })
      )
    } catch (error) {
      setLocalError(messageOf(error))
    } finally {
      setBusy(null)
    }
  }

  const command = async (
    name: string,
    action: () => Promise<SimulationStatus>
  ): Promise<void> => {
    setBusy(name)
    setLocalError(null)
    try {
      setStatus(await action())
    } catch (error) {
      setLocalError(messageOf(error))
    } finally {
      setBusy(null)
    }
  }

  const advanceFast = async (): Promise<void> => {
    const seconds = Number(fastDuration)
    if (!Number.isFinite(seconds) || seconds <= 0) {
      setLocalError('Fast advance duration must be finite and positive.')
      return
    }
    await command('advance', () => api.simulation.advance(seconds))
  }

  const displayedProject = status?.project ?? project
  const displayedError = localError ?? status?.lastError?.message ?? null
  const opModes = catalog.opModes
  const selectedProgramKey = selectedProgram ? programSelectionKey(selectedProgram) : ''
  const selectedOpMode = opModes.find((program) => programMatches(program, selectedProgram))
  const plugin = catalog.plugins.find(({ id }) => id === selectedOpMode?.pluginId)
  const scenarios = selectedOpMode
    ? catalog.scenarios.filter(({ pluginId }) => pluginId === selectedOpMode.pluginId)
    : []
  const selectedScenario = scenarios.find(({ id }) => id === scenarioId)
  const runner = status?.runner
  const selectedRateHz = Number(rateHz)
  const effectiveDtSeconds = runner?.dtSeconds
    ?? 1 / (Number.isFinite(selectedRateHz) && selectedRateHz > 0
      ? selectedRateHz
      : DEFAULT_RATE_HZ)

  return (
    <div className="simulate-workspace">
      {displayedError && (
        <div className="sim-error" role="alert">
          {displayedError}
        </div>
      )}

      <div className="sim-grid">
        <div className="sim-column">
          <section className="sim-card">
            <div className="sim-card-header">
              <div>
                <h2>Robot project</h2>
                <p>Select a directory containing spiderkit-sim.json.</p>
              </div>
              {configLocked && <span className="sim-lock">Locked for this session</span>}
            </div>
            <div className="sim-card-body">
              <div className="sim-form-grid">
                <div className="sim-field full">
                  <label>Project directory</label>
                  <div className="sim-path-row">
                    <div className="sim-path-value" title={projectDirectory}>
                      {projectDirectory || 'No robot project selected'}
                    </div>
                    <button
                      type="button"
                      className="ghost sm"
                      disabled={configLocked || busy !== null}
                      onClick={() => void chooseProject()}
                    >
                      Choose…
                    </button>
                  </div>
                </div>

                {displayedProject && (
                  <div className="sim-field full">
                    <div className="sim-project-summary">
                      <div className="sim-project-mark">RS</div>
                      <div className="sim-project-copy">
                        <div className="sim-project-name">{displayedProject.manifest.name}</div>
                        <div
                          className="sim-project-launcher"
                          title={displayedProject.launchCommand.join(' ')}
                        >
                          {displayedProject.launchCommand.join(' ')}
                        </div>
                      </div>
                      <span className="pill imported">Manifest loaded</span>
                    </div>
                  </div>
                )}

                <div className="sim-field">
                  <label htmlFor="sim-opmode">OpMode</label>
                  <select
                    id="sim-opmode"
                    value={selectedProgramKey}
                    disabled={configLocked || busy !== null || opModes.length === 0}
                    onChange={(event) => {
                      setSelectedProgram(parseProgramSelectionKey(event.target.value))
                      setScenarioId('')
                    }}
                  >
                    {opModes.length === 0 && <option value="">No OpModes discovered</option>}
                    {selectedProgram && !selectedOpMode && (
                      <option value={selectedProgramKey}>
                        {selectedProgram.pluginId
                          ? `${selectedProgram.pluginId} · ${selectedProgram.opModeId}`
                          : selectedProgram.opModeId}
                      </option>
                    )}
                    {opModes.map((opMode) => (
                      <option
                        key={programSelectionKey({ pluginId: opMode.pluginId, opModeId: opMode.id })}
                        value={programSelectionKey({ pluginId: opMode.pluginId, opModeId: opMode.id })}
                      >
                        {opMode.group ? `${opMode.group} · ` : ''}
                        {opMode.name}
                      </option>
                    ))}
                  </select>
                  <span className="sim-field-help">
                    {selectedOpMode
                      ? `${plugin?.name ?? selectedOpMode.pluginId} · ${selectedOpMode.type || 'OpMode'} · ${selectedOpMode.id}`
                      : 'Build or refresh the project to read its catalog.'}
                  </span>
                </div>
                <div className="sim-field">
                  <label htmlFor="sim-scenario">Scenario</label>
                  <select
                    id="sim-scenario"
                    value={scenarioId}
                    disabled={configLocked || busy !== null || !selectedOpMode}
                    onChange={(event) => setScenarioId(event.target.value)}
                  >
                    <option value="">Default initialization</option>
                    {scenarioId && !scenarios.some(({ id }) => id === scenarioId) && (
                      <option value={scenarioId}>{scenarioId}</option>
                    )}
                    {scenarios.map((scenario) => (
                      <option key={scenario.id} value={scenario.id}>
                        {scenario.name}
                      </option>
                    ))}
                  </select>
                  <span className="sim-field-help">
                    {selectedScenario?.description ||
                      (scenarios.length > 0
                        ? 'Optional robot-defined starting conditions.'
                        : 'This robot plugin does not declare additional scenarios.')}
                  </span>
                </div>
                <div className="sim-field">
                  <span className="sim-field-label">Project actions</span>
                  <div className="sim-inline-actions">
                    {displayedProject?.buildAvailable && (
                      <button
                        type="button"
                        className="ghost sm"
                        disabled={configLocked || busy !== null}
                        onClick={() => void buildProject()}
                      >
                        {busy === 'build' ? 'Building…' : 'Build'}
                      </button>
                    )}
                    <button
                      type="button"
                      className="ghost sm"
                      disabled={configLocked || busy !== null || !displayedProject}
                      onClick={() => void refreshCatalog()}
                    >
                      {busy === 'refresh' ? 'Refreshing…' : 'Refresh catalog'}
                    </button>
                  </div>
                  <span className="sim-field-help">Build runs the manifest command without a shell.</span>
                </div>
              </div>
            </div>
          </section>

          <section className="sim-card">
            <div className="sim-card-header">
              <div>
                <h2>Session inputs</h2>
                <p>NONE is neutral, LIVE is the latest browser frame, and RLOG is deterministic playback.</p>
              </div>
              {configLocked && <span className="sim-lock">Source modes locked for this session</span>}
            </div>
            <div className="sim-card-body">
              <div className="sim-inputs">
                <GamepadSourcePicker
                  slot={1}
                  source={gamepad1Source}
                  controllerIndex={controller1}
                  controllers={controllers}
                  lastActivatedIndex={lastActivatedIndex}
                  gamepadsSupported={gamepadsSupported}
                  sourceLocked={configLocked || busy === 'start'}
                  onSource={setGamepad1Source}
                  onController={setController1}
                  onPickRlog={() => void chooseRlog(1)}
                />
                <GamepadSourcePicker
                  slot={2}
                  source={gamepad2Source}
                  controllerIndex={controller2}
                  controllers={controllers}
                  lastActivatedIndex={lastActivatedIndex}
                  gamepadsSupported={gamepadsSupported}
                  sourceLocked={configLocked || busy === 'start'}
                  onSource={setGamepad2Source}
                  onController={setController2}
                  onPickRlog={() => void chooseRlog(2)}
                />
              </div>
              <div className="sim-session-options">
                <div className="sim-field">
                  <label htmlFor="sim-update-rate">Update rate</label>
                  <input
                    id="sim-update-rate"
                    type="number"
                    min="1"
                    max="1000"
                    step="1"
                    value={rateHz}
                    disabled={configLocked || busy === 'start'}
                    onChange={(event) => setRateHz(event.target.value)}
                  />
                  <span className="sim-field-help">
                    Fixed simulation ticks per second; 50 Hz gives a 20 ms timestep.
                  </span>
                </div>
                <div className="sim-field">
                  <label htmlFor="sim-fast-duration">Fast advance duration</label>
                  <input
                    id="sim-fast-duration"
                    type="number"
                    min={effectiveDtSeconds}
                    max={effectiveDtSeconds * 10_000}
                    step={effectiveDtSeconds}
                    value={fastDuration}
                    disabled={busy !== null}
                    onChange={(event) => setFastDuration(event.target.value)}
                  />
                  <span className="sim-field-help">
                    Seconds to execute without wall-clock pacing while paused.
                  </span>
                </div>
                <div className="sim-field">
                  <label htmlFor="sim-rlog-port">RLOG listen port</label>
                  <input
                    id="sim-rlog-port"
                    type="number"
                    min="0"
                    max="65535"
                    step="1"
                    value={rlogPort}
                    disabled={configLocked || busy === 'start'}
                    onChange={(event) => setRlogPort(event.target.value)}
                  />
                  <span className="sim-field-help">
                    Use 5802 if 5800 is occupied by a Limelight, or 0 to choose a free port.
                  </span>
                </div>
              </div>
            </div>
          </section>
        </div>

        <div className="sim-column">
          <section className="sim-card">
            <div className="sim-card-header">
              <div>
                <h2>Session control</h2>
                <p>Run is real-time; Step and bounded fast advance execute without wall-clock pacing.</p>
              </div>
              <PhaseBadge phase={phase} pid={status?.pid ?? null} />
            </div>
            <div className="sim-card-body">
              <div className="sim-runtime">
                <div>
                  <div className="sim-time">{formatSimTime(runner?.timeSeconds ?? 0)}</div>
                  <div className="sim-time-label">
                    simulation time · tick {runner?.tick ?? 0}
                  </div>
                </div>
                <div className="sim-controls">
                  {!sessionActive ? (
                    <button
                      type="button"
                      className="primary-control"
                      disabled={busy !== null}
                      onClick={() => void startSession()}
                    >
                      {busy === 'start' ? 'Starting…' : 'Start session'}
                    </button>
                  ) : (
                    <>
                      {phase === 'running' ? (
                        <button
                          type="button"
                          className="primary-control"
                          disabled={busy !== null}
                          onClick={() => void command('pause', api.simulation.pause)}
                        >
                          Pause
                        </button>
                      ) : (
                        <button
                          type="button"
                          className="primary-control"
                          disabled={busy !== null || phase !== 'paused'}
                          onClick={() => void command('resume', api.simulation.resume)}
                        >
                          Run
                        </button>
                      )}
                      <button
                        type="button"
                        className="ghost sm"
                        disabled={busy !== null || phase !== 'paused'}
                        onClick={() => void command('step', () => api.simulation.step(1))}
                      >
                        Step
                      </button>
                      <button
                        type="button"
                        className="ghost sm"
                        disabled={busy !== null || phase !== 'paused'}
                        onClick={() => void advanceFast()}
                      >
                        {busy === 'advance' ? 'Advancing…' : 'Run fast'}
                      </button>
                      <button
                        type="button"
                        className="ghost sm"
                        disabled={busy !== null}
                        onClick={() => void command('stop', api.simulation.stop)}
                      >
                        {busy === 'stop' ? 'Stopping…' : 'Stop'}
                      </button>
                    </>
                  )}
                </div>
              </div>
              {!sessionActive && (
                <label className="sim-start-option">
                  <input
                    type="checkbox"
                    checked={startPaused}
                    disabled={busy !== null}
                    onChange={(event) => setStartPaused(event.target.checked)}
                  />
                  <span>
                    <strong>Start paused</strong>
                    <small>Inspect the initialized robot, then step once or press Run.</small>
                  </span>
                </label>
              )}
            </div>
          </section>

          <section className="sim-card">
            <div className="sim-card-header">
              <div>
                <h2>Runtime</h2>
                <p>Freshness is measured where sim-cli receives each frame.</p>
              </div>
            </div>
            <div className="sim-card-body compact">
              {runner ? (
                <div className="sim-metrics">
                  <Metric label="Pacing" value={`${runner.rateHz} Hz · ${(runner.dtSeconds * 1000).toFixed(1)} ms`} />
                  <InputMetric slot={1} runtime={runner.gamepad1} />
                  <InputMetric slot={2} runtime={runner.gamepad2} />
                  <Metric
                    label="RLOG server"
                    value={
                      runner.rlog?.running
                        ? formatRlogEndpoint(runner.rlog)
                        : runner.rlog?.enabled
                          ? 'starting'
                          : 'off'
                    }
                    tone={runner.rlog?.running ? 'good' : undefined}
                  />
                </div>
              ) : (
                <div className="sim-empty-runtime">
                  Runtime metrics appear after the CLI accepts the session configuration.
                </div>
              )}
              {status?.lastError && status.stderrTail.length > 0 && (
                <details className="sim-diagnostics">
                  <summary>CLI diagnostics</summary>
                  <pre>{status.stderrTail.slice(-12).join('\n')}</pre>
                </details>
              )}
            </div>
          </section>

          <div className="sim-background-note">
            LIVE input is best-effort and never controls simulation pacing. Keep LogVue open while driving;
            a disconnected controller or stale renderer input becomes neutral automatically.
          </div>
        </div>
      </div>
    </div>
  )
}

function PhaseBadge({ phase, pid }: { phase: string; pid: number | null }): JSX.Element {
  const processState = pid !== null ? ` · PID ${pid}` : phase === 'stopped' ? ' · exited' : ''
  return (
    <div className={`sim-state-badge ${phase}`}>
      <span className="dot" />
      <span>{phase}{processState}</span>
    </div>
  )
}

function GamepadSourcePicker({
  slot,
  source,
  controllerIndex,
  controllers,
  lastActivatedIndex,
  gamepadsSupported,
  sourceLocked,
  onSource,
  onController,
  onPickRlog
}: {
  slot: Slot
  source: SimulationGamepadSource
  controllerIndex: number | null
  controllers: BrowserController[]
  lastActivatedIndex: number | null
  gamepadsSupported: boolean
  sourceLocked: boolean
  onSource: (source: SimulationGamepadSource) => void
  onController: (index: number | null) => void
  onPickRlog: () => void
}): JSX.Element {
  const controller = controllers.find(({ index }) => index === controllerIndex)
  const standardControllers = controllers.filter(({ mapping }) => mapping === 'standard')
  const hasNonStandard = controllers.some(({ mapping }) => mapping !== 'standard')

  const selectKind = (kind: SimulationGamepadSource['kind']): void => {
    if (kind === 'NONE') onSource({ kind: 'NONE' })
    else if (kind === 'LIVE') onSource({ kind: 'LIVE' })
    else onSource({ kind: 'RLOG', path: source.kind === 'RLOG' ? source.path : '' })
  }

  return (
    <div className="sim-input-card">
      <div className="sim-input-card-head">
        <strong>Gamepad {slot}</strong>
        <span className="sim-input-status">{source.kind}</span>
      </div>
      <div className="sim-source-tabs" aria-label={`Gamepad ${slot} source`}>
        {(['NONE', 'LIVE', 'RLOG'] as const).map((kind) => (
          <button
            key={kind}
            type="button"
            className={`sim-source-tab ${source.kind === kind ? 'active' : ''}`}
            disabled={sourceLocked}
            onClick={() => selectKind(kind)}
          >
            {kind}
          </button>
        ))}
      </div>
      <div className="sim-source-detail">
        {source.kind === 'NONE' && (
          <p className="sim-source-neutral">sim-cli samples a complete neutral gamepad on every tick.</p>
        )}
        {source.kind === 'LIVE' && (
          <>
            <select
              aria-label={`Physical controller for Gamepad ${slot}`}
              value={controllerIndex ?? ''}
              disabled={!gamepadsSupported}
              onChange={(event) =>
                onController(event.target.value === '' ? null : Number(event.target.value))
              }
            >
              <option value="">Select a controller…</option>
              {controllerIndex !== null && !controller && (
                <option value={controllerIndex}>Controller {controllerIndex + 1} · disconnected</option>
              )}
              {standardControllers.map((item) => (
                <option key={item.index} value={item.index}>
                  {item.id} {item.index === lastActivatedIndex ? '· active' : ''}
                </option>
              ))}
            </select>
            <div className={`sim-controller-hint ${controller?.connected ? 'connected' : ''}`}>
              <span className="dot" />
              <span>
                {!gamepadsSupported
                  ? 'The browser Gamepad API is unavailable.'
                  : controller?.connected
                    ? sourceLocked
                      ? 'Connected. You can rebind this LIVE source while the simulation runs.'
                      : 'Connected with Chromium standard mapping.'
                    : hasNonStandard
                      ? 'Press any button. A detected controller needs a standard mapping for v1.'
                      : 'Press any button so Chromium can discover the controller.'}
              </span>
            </div>
          </>
        )}
        {source.kind === 'RLOG' && (
          <>
            <div className="sim-path-row">
              <div className="sim-path-value" title={source.path}>
                {source.path || 'No RLOG selected'}
              </div>
              <button type="button" className="ghost sm" disabled={sourceLocked} onClick={onPickRlog}>
                Choose…
              </button>
            </div>
            <div className="sim-controller-hint connected">
              <span className="dot" />
              <span>Stop and start a fresh session to rewind playback.</span>
            </div>
          </>
        )}
      </div>
    </div>
  )
}

function Metric({
  label,
  value,
  tone
}: {
  label: string
  value: string
  tone?: 'good' | 'warn'
}): JSX.Element {
  return (
    <div className="sim-metric-row">
      <span>{label}</span>
      <span className={`sim-metric-value ${tone ?? ''}`}>{value}</span>
    </div>
  )
}

function InputMetric({
  slot,
  runtime
}: {
  slot: Slot
  runtime: SimulationGamepadRuntimeStatus | undefined
}): JSX.Element {
  if (!runtime) return <Metric label={`Gamepad ${slot}`} value="waiting" />
  const value =
    runtime.mode === 'LIVE'
      ? runtime.stale
        ? 'LIVE · stale → neutral'
        : runtime.connected
          ? `LIVE · fresh${runtime.ageMillis === null ? '' : ` ${Math.round(runtime.ageMillis)} ms`}`
          : 'LIVE · disconnected → neutral'
      : runtime.mode === 'RLOG'
        ? 'RLOG · sampled by tick'
        : 'NONE · neutral'
  return (
    <Metric
      label={`Gamepad ${slot}`}
      value={value}
      tone={runtime.mode === 'LIVE' && runtime.connected && !runtime.stale ? 'good' : runtime.stale ? 'warn' : undefined}
    />
  )
}

function validateSetup({
  project,
  programSelected,
  gamepad1Source,
  gamepad2Source,
  controller1,
  controller2,
  controllers,
  rlogPort
}: {
  project: SimulationProject | null
  programSelected: boolean
  gamepad1Source: SimulationGamepadSource
  gamepad2Source: SimulationGamepadSource
  controller1: number | null
  controller2: number | null
  controllers: BrowserController[]
  rlogPort: string
}): string | null {
  if (!project) return 'Choose a valid robot project before starting.'
  if (!programSelected) return 'Choose an OpMode before starting.'
  if (!validRlogPort(rlogPort)) return 'RLOG port must be a whole number from 0 to 65535.'
  if (gamepad1Source.kind === 'RLOG' && !gamepad1Source.path) return 'Choose the Gamepad 1 RLOG.'
  if (gamepad2Source.kind === 'RLOG' && !gamepad2Source.path) return 'Choose the Gamepad 2 RLOG.'
  if (
    gamepad1Source.kind === 'LIVE' &&
    (controller1 === null || !controllers.some(({ index, mapping }) => index === controller1 && mapping === 'standard'))
  ) {
    return 'Connect and choose a standard-mapped controller for Gamepad 1.'
  }
  if (
    gamepad2Source.kind === 'LIVE' &&
    (controller2 === null || !controllers.some(({ index, mapping }) => index === controller2 && mapping === 'standard'))
  ) {
    return 'Connect and choose a standard-mapped controller for Gamepad 2.'
  }
  return null
}

function persistControllerIndex(key: string, index: number | null): void {
  if (index === null) globalThis.localStorage?.removeItem(key)
  else globalThis.localStorage?.setItem(key, String(index))
}

function validRlogPort(value: string): boolean {
  if (!/^\d+$/.test(value)) return false
  const port = Number(value)
  return Number.isInteger(port) && port >= 0 && port <= 65535
}

function formatSimTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00.000'
  const minutes = Math.floor(seconds / 60)
  return `${minutes}:${(seconds % 60).toFixed(3).padStart(6, '0')}`
}

function formatRlogEndpoint(rlog: NonNullable<SimulationRunnerStatus['rlog']>): string {
  const address = rlog.bindAddress || '127.0.0.1'
  const port = rlog.actualPort ?? rlog.requestedPort
  return port === undefined ? address : `${address}:${port}`
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
