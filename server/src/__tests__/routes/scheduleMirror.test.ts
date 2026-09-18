/**
 * One scheduler, two tables (#108). A schedule made in the Novabot app must
 * land in dashboard_schedules (the table scheduleRunner fires) and a
 * dashboard schedule must be listed by the Novabot app.
 */
import express from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../mqtt/broker.js', () => ({
  isDeviceOnline: vi.fn().mockReturnValue(false),
  writeRawPublish: vi.fn().mockReturnValue(false),
  getBrokerDiagnostics: vi.fn().mockReturnValue({}),
  startMqttBroker: vi.fn(),
}));
vi.mock('../../mqtt/mapSync.js', () => ({
  publishToDevice: vi.fn(), publishToExtended: vi.fn(), onExtendedResponse: vi.fn(), offExtendedResponse: vi.fn(),
  onDeviceResponse: vi.fn(), offDeviceResponse: vi.fn(), requestMapList: vi.fn(), requestMapOutline: vi.fn(),
  publishRawToDevice: vi.fn(), publishEncryptedOnTopic: vi.fn(), publishToTopic: vi.fn(), goToChargePayload: vi.fn(),
  getNextCmdNum: vi.fn().mockReturnValue(1), initMapSync: vi.fn(), handleMapMessage: vi.fn(),
  handleExtendedResponse: vi.fn(), handleDeviceResponse: vi.fn(), notifyRespond: vi.fn(), setDemoInterceptor: vi.fn(), onMowerConnected: vi.fn(),
}));

import { db } from '../../db/database.js';
import { cutGrassPlanRouter } from '../../cloud-api/routes/cutGrassPlan.js';
import { dashboardRouter } from '../../routes/dashboard.js';
import { signToken } from '../../middleware/auth.js';
import { scheduleRepo, cutGrassPlanRepo } from '../../db/repositories/index.js';

const SN = 'LFIN1231000357';
const USER = 'user-357';
const app = express();
app.use(express.json());
app.use('/api/nova-data/appManage', cutGrassPlanRouter);
app.use('/api/dashboard', dashboardRouter);
const auth = { Authorization: `Bearer ${signToken({ userId: USER, email: 'w@example.com' })}` };

beforeEach(() => {
  for (const t of ['cut_grass_plans', 'dashboard_schedules', 'maps', 'equipment']) db.prepare(`DELETE FROM ${t}`).run();
  db.prepare('DELETE FROM users WHERE app_user_id = ?').run(USER);
  db.prepare(`INSERT INTO users (app_user_id, email, password) VALUES (?, 'w@example.com', 'x')`).run(USER);
  db.prepare(`INSERT INTO equipment (equipment_id, mower_sn, user_id) VALUES ('eq-357', ?, ?)`).run(SN, USER);
  db.prepare(`INSERT INTO maps (map_id, mower_sn, map_name, map_type, canonical_name, map_area) VALUES ('m1', ?, 'achter', 'work', 'map1', '[]')`).run(SN);
});

describe('Novabot app → dashboard', () => {
  it('a plan saved in the app becomes a runnable dashboard schedule', async () => {
    const res = await request(app).post('/api/nova-data/appManage/saveCutGrassPlan').set(auth).send({
      sn: SN, timezone: 'Europe/Amsterdam', weeks: ['Mon', 'Wed'], startTime: '09:00', endTime: '11:00',
      cutGrassHeight: 4, area: 10, repeatType: 1, areaMapFileNames: ['map1_work.csv'], times: 1, workDay: 0,
    });
    const planId = res.body.value.planId as string;
    const sched = scheduleRepo.findByIdAndMower(`app:${planId}`, SN)!;
    expect(sched).toBeTruthy();
    expect(JSON.parse(sched.weekdays)).toEqual([1, 3]);
    expect(sched.start_time).toBe('09:00');
    expect(sched.map_id).toBe('m1');
    expect(sched.cutting_height).toBe(4);
    expect(sched.enabled).toBe(1);

    await request(app).post('/api/nova-data/appManage/updateCutGrassPlan').set(auth).send({ planId, weeks: ['Fri'], startTime: '10:30' });
    const upd = scheduleRepo.findByIdAndMower(`app:${planId}`, SN)!;
    expect(JSON.parse(upd.weekdays)).toEqual([5]);
    expect(upd.start_time).toBe('10:30');

    await request(app).post('/api/nova-data/appManage/deleteCutGrassPlan').set(auth).send({ planId });
    expect(scheduleRepo.findByIdAndMower(`app:${planId}`, SN)).toBeUndefined();
  });
});

describe('dashboard → Novabot app', () => {
  it('a dashboard schedule is listed by the app and removed with it', async () => {
    const res = await request(app).post(`/api/dashboard/schedules/${SN}`).send({
      startTime: '07:15', endTime: '08:00', weekdays: [0, 6], mapId: 'm1', mapName: 'achter', cuttingHeight: 50,
    });
    const scheduleId = res.body.schedule.scheduleId ?? res.body.schedule.schedule_id;
    const plan = cutGrassPlanRepo.findById(scheduleId)!;
    expect(plan).toBeTruthy();
    expect(JSON.parse(plan.weekday!)).toEqual(['Sun', 'Sat']);
    expect(plan.cut_grass_height).toBe(5);
    expect(plan.area).toBe(10);

    const list = await request(app).post('/api/nova-data/appManage/queryCutGrassPlan').set(auth).send({ sn: SN });
    expect(list.body.value.Sat).toHaveLength(1);
    expect(list.body.value.Sat[0].startTime).toBe('07:15');

    await request(app).patch(`/api/dashboard/schedules/${SN}/${scheduleId}`).send({ startTime: '06:00' });
    expect(cutGrassPlanRepo.findById(scheduleId)!.start_time).toBe('06:00');

    await request(app).delete(`/api/dashboard/schedules/${SN}/${scheduleId}`);
    expect(cutGrassPlanRepo.findById(scheduleId)).toBeUndefined();
  });
});
