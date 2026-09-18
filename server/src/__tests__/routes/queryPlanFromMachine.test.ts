/**
 * The mower asks for its schedules the way mqtt_node's http_post_upload
 * (mode 5) sends them: multipart/form-data with `sn` and `week`, no JSON.
 * Without a multipart parser req.body stayed empty, the route answered
 * "sn required", and a schedule made in the Novabot app never reached the
 * mower (#108). Both 5.7.1 and 6.0.2 chassis_control parse the answer for
 * startTime / endTime / areaFileAlias.
 */
import express from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../mqtt/broker.js', () => ({ isDeviceOnline: vi.fn().mockReturnValue(true) }));

import { db } from '../../db/database.js';
import { cutGrassPlanRouter } from '../../cloud-api/routes/cutGrassPlan.js';
import { cutGrassPlanRepo } from '../../db/repositories/index.js';

const SN = 'LFIN1231000357';
const app = express();
app.use(express.json());
app.use('/api/nova-data/cutGrassPlan', cutGrassPlanRouter);

beforeEach(() => {
  db.prepare('DELETE FROM cut_grass_plans').run();
  db.prepare('DELETE FROM equipment').run();
  db.prepare(`INSERT INTO equipment (equipment_id, mower_sn) VALUES ('eq-357', ?)`).run(SN);
  cutGrassPlanRepo.create({
    planId: 'plan-1', equipmentId: 'eq-357', userId: '1',
    startTime: '09:00', endTime: '11:00', weekday: JSON.stringify(['Mon', 'Wed']),
    repeat: true, repeatCount: 1, repeatType: '1', workTime: 120,
    workArea: JSON.stringify(['map0_work.csv']), workDay: null,
    cutGrassHeight: 4, area: 1, timezone: 'Europe/Amsterdam',
  });
});

describe('POST /queryPlanFromMachine', () => {
  it('answers the multipart request the mower actually sends', async () => {
    const res = await request(app)
      .post('/api/nova-data/cutGrassPlan/queryPlanFromMachine')
      .field('sn', SN)
      .field('week', 'Mon');
    expect(res.status).toBe(200);
    expect(res.body.code).toBe(200);
    expect(res.body.value).toHaveLength(1);
    expect(res.body.value[0]).toMatchObject({ startTime: '09:00', endTime: '11:00', cutGrassHeight: 4 });
    // chassis_control counts zones with areaFileAlias.size(): must be an array
    expect(res.body.value[0].areaFileAlias).toEqual(['map0_work.csv']);
  });

  it('filters on the day when the mower names one', async () => {
    const wed = await request(app).post('/api/nova-data/cutGrassPlan/queryPlanFromMachine').field('sn', SN).field('week', 'Wed');
    expect(wed.body.value).toHaveLength(1);
    const tue = await request(app).post('/api/nova-data/cutGrassPlan/queryPlanFromMachine').field('sn', SN).field('week', 'Tue');
    expect(tue.body.value).toHaveLength(0);
    // an unknown week token (raw byte from the STM32) does not hide anything
    const raw = await request(app).post('/api/nova-data/cutGrassPlan/queryPlanFromMachine').field('sn', SN).field('week', '\u0001');
    expect(raw.body.value).toHaveLength(1);
  });

  it('still answers JSON (dashboard / curl)', async () => {
    const res = await request(app)
      .post('/api/nova-data/cutGrassPlan/queryPlanFromMachine')
      .send({ sn: SN });
    expect(res.body.value).toHaveLength(1);
  });

  it('refuses without a serial', async () => {
    const res = await request(app).post('/api/nova-data/cutGrassPlan/queryPlanFromMachine').field('week', 'Mon');
    expect(res.body.code).toBe(400);
  });
});
