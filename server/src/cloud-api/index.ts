/**
 * Cloud-API — frozen HTTP surface for the official Novabot app.
 *
 * This file wires every route under /api/nova-*\/* and /api/novabot-message/*
 * onto the express app. It must not be imported from routes/dashboard,
 * routes/admin*, or routes/setup. See README.md for the rules.
 */
import type { Express } from 'express';

export function mountCloudApi(_app: Express): void {
  // Populated in phase 3 when routes are moved in.
}
