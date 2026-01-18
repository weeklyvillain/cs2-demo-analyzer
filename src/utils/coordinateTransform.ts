// Coordinate transformation utilities based on CS Demo Analyzer
// Reference: cs-demo-manager-main/src/ui/maps/get-scaled-coordinate-x.ts
//            cs-demo-manager-main/src/ui/maps/get-scaled-coordinate-y.ts

import type { MapConfig } from './mapConfig'

/**
 * Transform game X coordinate to radar pixel coordinate
 * Formula: (xFromDemo - posX) / scale
 */
export function getScaledCoordinateX(mapConfig: MapConfig, imageSize: number, xFromDemo: number): number {
  const xForDefaultRadarWidth = (xFromDemo - mapConfig.posX) / mapConfig.scale
  const scaledX = (xForDefaultRadarWidth * imageSize) / mapConfig.radarWidth
  return scaledX
}

/**
 * Transform game Y coordinate to radar pixel coordinate
 * Formula: (posY - yFromDemo) / scale (Y is flipped)
 */
export function getScaledCoordinateY(mapConfig: MapConfig, imageSize: number, yFromDemo: number): number {
  const yForDefaultRadarHeight = (mapConfig.posY - yFromDemo) / mapConfig.scale
  const scaledY = (yForDefaultRadarHeight * imageSize) / mapConfig.radarHeight
  return scaledY
}

/**
 * Convert degrees to radians
 */
export function degreesToRadians(degrees: number): number {
  return degrees * (Math.PI / 180)
}
