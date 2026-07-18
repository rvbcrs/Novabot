/**
 * Data Access Layer — all database operations go through these repositories.
 *
 * Benefits:
 * - SQL injection safe (all queries use prepared statements with parameters)
 * - Type-safe (typed input/output for all operations)
 * - Single source of truth for all DB operations
 * - Testable (can be mocked)
 * - No raw SQL in route handlers
 */

export { UserRepository, userRepo } from './users.js';
export { EquipmentRepository, equipmentRepo } from './equipment.js';
export { MapRepository, mapRepo } from './maps.js';
export { DeviceRepository, deviceRepo } from './devices.js';
export { MessageRepository, messageRepo } from './messages.js';
export { ScheduleRepository, scheduleRepo, rainSettingsRepo, seamFixRepo } from './schedules.js';
export type { RainSettingsRow, RainSettingsUpdate } from './schedules.js';
export { EmailCodeRepository, emailCodeRepo } from './emailCodes.js';
export { CutGrassPlanRepository, cutGrassPlanRepo } from './cutGrassPlans.js';
export { MapUploadRepository, mapUploadRepo } from './mapUploads.js';
export { DeviceSettingsRepository, deviceSettingsRepo } from './deviceSettings.js';
export { SignalHistoryRepository, signalHistoryRepo } from './signalHistory.js';
export { VirtualWallRepository, virtualWallRepo } from './virtualWalls.js';
export { OtaVersionRepository, otaVersionRepo } from './otaVersions.js';
export { pushTokensRepo, type PushTokenRow } from './pushTokens.js';
export { remoteSupportIdentitiesRepo } from './remoteSupportIdentities.js';
export { terrainGridRepo, type TerrainGridRow } from './terrainGrids.js';
export { terrainClusterRepo, type TerrainClusterRow } from './terrainClusters.js';
export { WalkerBundleRepository, walkerBundleRepo } from './walkerBundles.js';
export type { WalkerBundleRow, CreateWalkerBundleData } from './walkerBundles.js';
export { MapEditsRepository, mapEditsRepo } from './mapEdits.js';
export type { MapEditDraftRow, MapVersionRow } from './mapEdits.js';
