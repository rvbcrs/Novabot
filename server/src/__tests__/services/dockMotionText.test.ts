/**
 * A stop during a dock measurement reached the user as the firmware's raw
 * reason ("motion telemetry stale: /robot_combination_localization/...").
 * It must read as plain words with a next step, in the reader's language.
 */
import { describe, it, expect, vi } from 'vitest';

// dockMotion publishes over MQTT; the broker chain is not needed for its texts.
vi.mock('../../mqtt/mapSync.js', () => ({ publishToExtended: vi.fn() }));
import { readableDockMotionError } from '../../services/dockMotion.js';
import { renderMsg } from '../../services/serverText.js';

const en = (raw: string) => renderMsg('en', readableDockMotionError(raw));

describe('readableDockMotionError', () => {
  it('turns the reasons users hit into plain sentences', () => {
    expect(en('motion telemetry stale: /robot_combination_localization/combination_status')).toMatch(/^The mower's position data dropped out/);
    // Not "wait a minute": its RTK was not Fixed (the wizard showed "RTK: ?" on
    // the dock), and waiting does not help when it stays that way (Aaron, Oct 2026).
    expect(en('RTK corrections or localization lost during motion')).toMatch(/^The mower lost RTK Fixed .*"RTK: Fixed"/);
    expect(en('robot is busy, low on battery or in error')).toMatch(/30% battery/);
    expect(en('chassis stop or fault')).toMatch(/STOP button/);
    expect(en('dock pattern lost')).toMatch(/camera could not see the pattern/);
    expect(en('visual docking ended without charging contact (native code 3)')).toMatch(/no charging contact/);
    expect(en('visual docking cancellation not confirmed; use the mower STOP button')).toMatch(/did not confirm that it stopped/);
  });
  // custom-51 splits the combined RTK/localization stop in three, and each
  // needs its own next step (GH #158).
  it('tells a lost RTK Fixed, stale corrections and an unready localization apart', () => {
    const fixed = en('RTK not Fixed during motion (quality 5)');
    const stale = en('RTK corrections stale during motion (age 4.0 s)');
    const localization = en('localization status not 200 during motion (status 100)');
    expect(fixed).toMatch(/^The mower lost RTK Fixed during the check.*"RTK: Fixed"/);
    expect(fixed).not.toMatch(/corrections/);
    expect(stale).toMatch(/^The RTK corrections from the charging station did not arrive in time.*has power/);
    expect(localization).toMatch(/^The mower's localization was not ready.*right after it leaves the dock.*Wait a minute/);
    expect(localization).not.toMatch(/RTK/);
    expect(new Set([fixed, stale, localization, en('RTK corrections or localization lost during motion')]).size).toBe(4);
    for (const text of [fixed, stale, localization]) expect(text).not.toMatch(/quality|status \d|age \d/);
  });
  it('never shows a ROS topic for a known reason, and keeps an unknown one visible', () => {
    expect(en('motion telemetry stale: /robot_decision/map_position')).not.toMatch(/\//);
    expect(en('something new')).toBe('The check stopped on the mower (something new).');
  });
  it('speaks the reader\'s language', () => {
    expect(renderMsg('nl', readableDockMotionError('dock pattern lost'))).toMatch(/^De camera zag het patroon/);
    expect(renderMsg('de', readableDockMotionError('chassis stop or fault'))).toMatch(/STOP-Taste/);
    expect(renderMsg('nl', readableDockMotionError('localization status not 200 during motion (status 100)'))).toMatch(/^De lokalisatie van de maaier/);
    expect(renderMsg('fr', readableDockMotionError('RTK corrections stale during motion (age 4.0 s)'))).toMatch(/^Les corrections RTK/);
    expect(renderMsg('de', readableDockMotionError('RTK not Fixed during motion (quality 1)'))).toMatch(/RTK-Fixed verloren/);
  });
});
