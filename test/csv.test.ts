import { describe, expect, it } from 'vitest';
import { parseCsv } from '../src/import/csv.js';
import { detectSource, normalizeRows } from '../src/import/index.js';

const toggl = `User,Email,Client,Project,Task,Description,Billable,Start date,Start time,End date,End time,Duration,Tags
Ada,ada@x.com,Acme Corp,Website Redesign,,Hero section,Yes,2024-03-04,09:00:00,2024-03-04,11:30:00,02:30:00,design
Ada,ada@x.com,Acme Corp,Website Redesign,,"Nav, footer",No,2024-03-05,13:15:00,2024-03-05,14:00:00,00:45:00,`;

const harvest = `Date,Client,Project,Project Code,Task,Notes,Hours,Billable?,Invoiced?,First Name,Last Name,Roles,Employee?,Billable Rate,Billable Amount,Cost Rate,Cost Amount,Currency,External Reference URL
2024-03-04,Globex,Brand Identity,,Design,Logo concepts,1.5,Yes,No,Ada,L,,Yes,150,225,,,USD,`;

const clockify = `Project,Client,Description,Task,User,Group,Email,Tags,Billable,Start Date,Start Time,End Date,End Time,Duration (h),Duration (decimal),Billable Rate (USD),Billable Amount (USD)
Mobile App,Acme Corp,Push notifications,,Ada,,ada@x.com,dev,Yes,03/06/2024,10:00:00 AM,03/06/2024,12:00:00 PM,02:00:00,2.00,150.00,300.00`;

describe('csv import', () => {
  it('parses quoted fields', () => {
    const rows = parseCsv('a,b\n"x, y","he said ""hi"""\n');
    expect(rows).toEqual([['a', 'b'], ['x, y', 'he said "hi"']]);
  });
  it('detects sources', () => {
    expect(detectSource(parseCsv(toggl)[0])).toBe('toggl');
    expect(detectSource(parseCsv(harvest)[0])).toBe('harvest');
    expect(detectSource(parseCsv(clockify)[0])).toBe('clockify');
  });
  it('normalizes toggl', () => {
    const { rows, errors } = normalizeRows('toggl', parseCsv(toggl));
    expect(errors).toEqual([]);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ client: 'Acme Corp', project: 'Website Redesign', description: 'Hero section', date: '2024-03-04', duration_min: 150, billable: true, tags: ['design'] });
    expect(rows[1]).toMatchObject({ description: 'Nav, footer', duration_min: 45, billable: false });
  });
  it('normalizes harvest', () => {
    const { rows } = normalizeRows('harvest', parseCsv(harvest));
    expect(rows[0]).toMatchObject({ client: 'Globex', project: 'Brand Identity', duration_min: 90, billable: true, date: '2024-03-04' });
    expect(rows[0].description).toContain('Logo concepts');
  });
  it('normalizes clockify with 12h times and US dates', () => {
    const { rows, errors } = normalizeRows('clockify', parseCsv(clockify));
    expect(errors).toEqual([]);
    expect(rows[0]).toMatchObject({ project: 'Mobile App', client: 'Acme Corp', date: '2024-03-06', duration_min: 120, billable: true });
    expect(rows[0].start).toContain('T10:00');
  });
});
