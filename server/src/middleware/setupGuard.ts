/**
 * Setup Guard middleware — redirects to wizard if setup is not complete.
 *
 * Setup is considered complete when:
 * 1. At least one user account exists in the DB
 * 2. At least one equipment (mower) is bound
 *
 * When NOT complete:
 * - API routes used by the Novabot app (/api/nova-*) are blocked with 503
 * - Browser requests are redirected to the setup wizard
 * - Wizard API routes (/api/setup/*) are always allowed
 * - MQTT broker runs regardless (mower needs to connect)
 *
 * When complete:
 * - All routes work normally
 * - Browser gets the status page (spoor 1) or dashboard (spoor 2)
 */

import { userRepo, equipmentRepo } from '../db/repositories/index.js';
import type { Request, Response, NextFunction } from 'express';

let _setupComplete: boolean | null = null;

/**
 * Check if initial setup has been completed.
 * Result is cached — call invalidateSetupCache() after wizard completes.
 */
export function isSetupComplete(): boolean {
  if (_setupComplete !== null) return _setupComplete;

  const userCount = userRepo.count();
  const equipCount = equipmentRepo.count();

  _setupComplete = userCount > 0;
  return _setupComplete;
}

/**
 * Call this after the setup wizard completes to re-check.
 */
export function invalidateSetupCache(): void {
  _setupComplete = null;
}

/**
 * Express middleware that blocks app API routes when setup is incomplete.
 * Wizard routes and MQTT are always allowed.
 */
export function setupGuard(req: Request, res: Response, next: NextFunction): void {
  // Always allow:
  // - Setup wizard API routes
  // - Network connection check (mower firmware calls this)
  // - Mower log uploads
  // - Static files for wizard UI
  if (
    req.path.startsWith('/api/setup') ||
    req.path.startsWith('/api/admin') ||
    req.path.startsWith('/api/nova-user/appUser/login') ||
    req.path.startsWith('/api/nova-user/appUser/register') ||
    req.path.startsWith('/api/nova-network') ||
    req.path.startsWith('/api/dashboard/admin/import') ||
    req.path.startsWith('/x3/') ||
    req.path.startsWith('/setup') ||
    req.path === '/admin'
  ) {
    next();
    return;
  }

  if (isSetupComplete()) {
    next();
    return;
  }

  // Setup not complete — let API requests through anyway
  // (login auto-import will create the user on first login attempt)
  if (req.path.startsWith('/api/')) {
    next();
    return;
  }

  // Browser request: redirect to admin (which has cloud import + first-time setup)
  res.redirect('/admin');
}
