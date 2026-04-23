/**
 * Cloud-API — frozen HTTP surface for the official Novabot app.
 *
 * This file wires every route under /api/nova-*\/* and /api/novabot-message/*
 * (plus the /api/nova-message/* alias the maaier firmware uses) onto the
 * express app. It must not be imported from routes/dashboard, routes/admin*,
 * or routes/setup. See README.md for the rules.
 *
 * Mount table moved here from `server/src/index.ts` on 2026-04-23 (Task 9).
 * External URLs are IDENTICAL to the pre-move layout — same paths, same order,
 * same router instances. Any change to a path or router assignment requires a
 * CHANGELOG entry and a contract-test update.
 */
import type { Express } from 'express';
import { appUserRouter }        from './routes/appUser.js';
import { validateRouter }       from './routes/validate.js';
import { equipmentRouter }      from './routes/equipment.js';
import { otaUpgradeRouter }     from './routes/otaUpgrade.js';
import { cutGrassPlanRouter }   from './routes/cutGrassPlan.js';
import { equipmentStateRouter } from './routes/equipmentState.js';
import { mapRouter }            from './routes/map.js';
import { logRouter }            from './routes/log.js';
import { messageRouter }        from './routes/message.js';
import { machineMessageRouter } from './routes/machineMessage.js';
import { networkRouter }        from './routes/network.js';

export function mountCloudApi(app: Express): void {
  // nova-user service
  // Alias: app roept /api/nova-user/user/... aan (niet /appUser/)
  // Validate routes ook under /user/ — app kan sendAppRegistEmailCode e.d. via /user/ aanroepen
  app.use('/api/nova-user/user',       validateRouter);
  app.use('/api/nova-user/user',       appUserRouter);
  app.use('/api/nova-user/appUser',    appUserRouter);
  app.use('/api/nova-user/validate',   validateRouter);
  app.use('/api/nova-user/equipment',  equipmentRouter);
  app.use('/api/nova-user/otaUpgrade', otaUpgradeRouter);

  // nova-data service
  app.use('/api/nova-data/appManage',       cutGrassPlanRouter);
  app.use('/api/nova-data/cutGrassPlan',    cutGrassPlanRouter);
  app.use('/api/nova-data/equipmentState',  equipmentStateRouter);

  // nova-file-server service
  app.use('/api/nova-file-server/map', mapRouter);
  app.use('/api/nova-file-server/log', logRouter);

  // novabot-message service (maaier stuurt naar nova-message, app naar novabot-message)
  app.use('/api/novabot-message/message',        messageRouter);
  app.use('/api/novabot-message/machineMessage',  machineMessageRouter);
  app.use('/api/nova-message/message',            messageRouter);
  app.use('/api/nova-message/machineMessage',     machineMessageRouter);

  // nova-network service (aangeroepen door charger firmware via HTTP)
  app.use('/api/nova-network/network', networkRouter);
}
