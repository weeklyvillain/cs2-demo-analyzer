// CS2 Map coordinate transformation settings
// Based on CS Demo Analyzer format: pos_x, pos_y, and scale
// These values come from map_name.txt files in CS2/CSGO
// Reference: https://cs-demo-manager.com/docs/guides/maps

export interface MapConfig {
  name: string
  // Origin point in game coordinates (from pos_x, pos_y in map_name.txt)
  posX: number
  posY: number
  // Scale factor from game units to radar pixels (from scale in map_name.txt)
  scale: number
  // Radar image dimensions (usually 1024x1024)
  radarWidth: number
  radarHeight: number
}

// Map configurations from CS Demo Analyzer (CS2 values)
// Source: cs-demo-manager-main/src/node/database/maps/default-maps.ts
export const mapConfigs: MapConfig[] = [
  {
    name: 'de_dust2',
    posX: -2476,
    posY: 3239,
    scale: 4.4,
    radarWidth: 1024,
    radarHeight: 1024,
  },
  {
    name: 'de_mirage',
    posX: -3230,
    posY: 1713,
    scale: 5.0,
    radarWidth: 1024,
    radarHeight: 1024,
  },
  {
    name: 'de_inferno',
    posX: -2087,
    posY: 3870,
    scale: 4.9,
    radarWidth: 1024,
    radarHeight: 1024,
  },
  {
    name: 'de_ancient',
    posX: -2953,
    posY: 2164,
    scale: 5.0,
    radarWidth: 1024,
    radarHeight: 1024,
  },
  {
    name: 'de_anubis',
    posX: -2796,
    posY: 3328,
    scale: 5.22,
    radarWidth: 1024,
    radarHeight: 1024,
  },
  {
    name: 'de_cache',
    posX: -2000,
    posY: 3250,
    scale: 5.5,
    radarWidth: 1024,
    radarHeight: 1024,
  },
  {
    name: 'de_nuke',
    posX: -3453,
    posY: 2887,
    scale: 7.0,
    radarWidth: 1024,
    radarHeight: 1024,
  },
  {
    name: 'de_overpass',
    posX: -4831,
    posY: 1781,
    scale: 5.2,
    radarWidth: 1024,
    radarHeight: 1024,
  },
  {
    name: 'de_vertigo',
    posX: -3168,
    posY: 1762,
    scale: 4.0,
    radarWidth: 1024,
    radarHeight: 1024,
  },
]

export function getMapConfig(mapName: string): MapConfig | null {
  const normalized = mapName.toLowerCase().replace(/^de_/, '')
  const fullName = mapName.toLowerCase().startsWith('de_') ? mapName.toLowerCase() : `de_${normalized}`
  
  return mapConfigs.find(config => config.name === fullName) || null
}
