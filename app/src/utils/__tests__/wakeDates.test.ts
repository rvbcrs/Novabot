import { describe, it, expect } from 'vitest';
import { nextWakeDates } from '../wakeDates';

describe('nextWakeDates', () => {
  it('in November: the coming spring', () => {
    expect(nextWakeDates(new Date(2026, 10, 12))).toEqual(['2027-03-01', '2027-04-01', '2027-05-01']);
  });
  it('in mid March: April and May this year, March next year', () => {
    expect(nextWakeDates(new Date(2027, 2, 15))).toEqual(['2028-03-01', '2027-04-01', '2027-05-01']);
  });
});
