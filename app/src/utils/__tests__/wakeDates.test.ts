import { describe, it, expect } from 'vitest';
import { nextWakeDates } from '../wakeDates';

describe('nextWakeDates', () => {
  it('in November (northern winter): March, April, May', () => {
    expect(nextWakeDates(new Date(2026, 10, 12))).toEqual(['2027-03-01', '2027-04-01', '2027-05-01']);
  });
  it('in May (southern winter): September, October, November', () => {
    expect(nextWakeDates(new Date(2027, 4, 20))).toEqual(['2027-09-01', '2027-10-01', '2027-11-01']);
  });
  it('crosses the year end', () => {
    expect(nextWakeDates(new Date(2027, 9, 31))).toEqual(['2028-02-01', '2028-03-01', '2028-04-01']);
  });
});
