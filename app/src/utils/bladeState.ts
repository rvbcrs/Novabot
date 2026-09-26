/**
 * Whether the blades may be spinning: the only state that locks the joystick.
 * Same rule as dashboard/src/utils/mowerActivity.ts bladesMaySpin; keep both in
 * sync. Nothing reports the blade by default (blade_speed needs opt-in
 * telemetry on OpenNova firmware, v6 does not send mow_blade_work_time), so
 * this reads the coverage state. Live .100 log 2026-09-25: the planner lowers
 * the blade at COVERING, keeps it down through AVOIDING and MOVING between
 * lanes, and raises it ("stop blade") at a slip, a stop or the finish.
 * ponytail: MOVING from the dock to the first lane runs with the blade up but
 * reads the same, so the joystick stays locked there too.
 */
const BLADE_WORK = /Work:(COVERING|BOUNDARY_COVERING|COVERING_MISSING|AVOIDING|MOVING)\b/;
const BLADE_WORK_STATUS = ['90', '91', '92', '93', '94',
  'Mowing', 'Avoiding obstacle', 'Driving', 'Edge cutting', 'Re-covering missed spots'];

export function bladesMaySpin(s: Record<string, string | undefined>): boolean {
  return BLADE_WORK.test(s.msg ?? '')
    || BLADE_WORK_STATUS.includes(s.work_status ?? '')
    || s.edge_active === '1'
    || (parseInt(s.blade_speed ?? '0', 10) || 0) !== 0;
}
