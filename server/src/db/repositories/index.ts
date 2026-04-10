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
