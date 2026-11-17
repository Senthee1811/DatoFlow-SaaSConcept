/** Offset of `timeZone` from UTC at `instant`, in milliseconds (positive east of Greenwich). */
export function timeZoneOffsetMs(instant: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(instant);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  const asUtc = Date.UTC(
    get('year'),
    get('month') - 1,
    get('day'),
    get('hour'),
    get('minute'),
    get('second'),
  );
  return asUtc - Math.floor(instant.getTime() / 1000) * 1000;
}

/**
 * The UTC instant at which a calendar day starts in the organization's timezone.
 * Times are stored in UTC and shown in the organization's timezone, so date filters use its days.
 */
export function startOfDayInZone(isoDate: string, timeZone: string): Date {
  const [y, m, d] = isoDate.split('-').map(Number) as [number, number, number];
  const guess = Date.UTC(y, m - 1, d);
  const first = guess - timeZoneOffsetMs(new Date(guess), timeZone);
  // A second pass settles days where the offset changes (daylight saving).
  return new Date(guess - timeZoneOffsetMs(new Date(first), timeZone));
}

/** The start of the day after `isoDate` in the timezone: the exclusive end of that day. */
export function endOfDayInZone(isoDate: string, timeZone: string): Date {
  const [y, m, d] = isoDate.split('-').map(Number) as [number, number, number];
  const next = new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10);
  return startOfDayInZone(next, timeZone);
}

/**
 * A wall-clock date-time typed in the organization's timezone (`YYYY-MM-DDTHH:mm`, as a
 * datetime-local input gives it) as the UTC instant it names.
 */
export function zonedDateTimeToUtc(local: string, timeZone: string): Date {
  const [date, time = '00:00'] = local.split('T') as [string, string?];
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  const [hh, mm] = time.split(':').map(Number) as [number, number];
  const guess = Date.UTC(y, m - 1, d, hh, mm);
  const first = guess - timeZoneOffsetMs(new Date(guess), timeZone);
  // A second pass settles times near a daylight-saving change.
  return new Date(guess - timeZoneOffsetMs(new Date(first), timeZone));
}

/** An instant as `YYYY-MM-DDTHH:mm` in the timezone, for a datetime-local input. */
export function utcToZonedInput(instant: Date, timeZone: string): string {
  const offset = timeZoneOffsetMs(instant, timeZone);
  return new Date(Math.floor(instant.getTime() / 60_000) * 60_000 + offset)
    .toISOString()
    .slice(0, 16);
}
