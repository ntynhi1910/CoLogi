import type { F3Evaluation } from '../../types/f3'

/** Parse a backend decimal/number; anything non-finite counts as 0. */
export const num = (value: unknown): number => {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : 0
}

export function getF3CapacityMetrics(result: F3Evaluation) {
  if (result.status === 'INVALID_PLAN') {
    return {
      requiredKg: 0,
      capacityKg: 0,
      usedPercent: null as number | null,
      backendPercent: null as number | null,
      waveCount: 0,
      vehicleCount: 0,
    }
  }

  const requiredKg = num(result.total_required_weight_kg)

  const capacityKg = result.waves.reduce(
    (total, wave) => total + num(wave.vehicle.capacity_kg),
    0
  )

  const usedPercent =
    capacityKg > 0 ? Math.round((requiredKg / capacityKg) * 100) : null

  const rawBackendPercent = Number(result.utilization_pct)

  return {
    requiredKg,
    capacityKg,
    usedPercent,
    backendPercent: Number.isFinite(rawBackendPercent) ? rawBackendPercent : null,
    waveCount: result.waves.length,
    vehicleCount: result.vehicles_required,
  }
}
