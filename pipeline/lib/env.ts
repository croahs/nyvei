// Environment: .env locally, plain environment variables in CI (repository
// secrets). Values already in the environment win over .env.

import { existsSync } from "node:fs";

export function loadEnv(): void {
  if (existsSync(".env")) process.loadEnvFile(".env");
}

export interface PrivacyZone {
  lon: number;
  lat: number;
  radiusM: number;
}

/**
 * PRIVACY_ZONE=lat,lon,radius_m: the circle around home that no published
 * file may point at. undefined when unset; malformed values throw.
 */
export function privacyZone(): PrivacyZone | undefined {
  const raw = process.env.PRIVACY_ZONE?.trim();
  if (!raw) return undefined;
  const parts = raw.split(",").map((s) => Number(s.trim()));
  const [lat, lon, radiusM] = parts;
  if (parts.length !== 3 || !parts.every(Number.isFinite) || Math.abs(lat!) > 90 || Math.abs(lon!) > 180 || radiusM! <= 0) {
    throw new Error("PRIVACY_ZONE must be lat,lon,radius_m");
  }
  return { lat: lat!, lon: lon!, radiusM: radiusM! };
}
