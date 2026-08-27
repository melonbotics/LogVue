export class SimulationProjectError extends Error {
  constructor(
    readonly code: string,
    message: string
  ) {
    super(message)
    this.name = 'SimulationProjectError'
  }
}
