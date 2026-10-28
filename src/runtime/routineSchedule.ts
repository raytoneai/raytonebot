const CRON_FIELDS = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 7]] as const;

/** Five-field cron (minute hour day month weekday): `*`, numbers, ranges, lists and steps. */
export function cronProblem(expression: string): string | undefined {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) return "Use five fields: minute hour day month weekday.";
  for (const [index, field] of fields.entries()) {
    const [min, max] = CRON_FIELDS[index];
    for (const part of field.split(",")) {
      const match = /^(\*|(\d+)(?:-(\d+))?)(?:\/(\d+))?$/.exec(part);
      if (!match) return `"${field}" is not a valid cron field.`;
      const from = match[2] === undefined ? min : Number(match[2]);
      const to = match[3] === undefined ? (match[2] === undefined ? max : from) : Number(match[3]);
      const step = match[4] === undefined ? 1 : Number(match[4]);
      if (from < min || to > max || from > to || !Number.isSafeInteger(step) || step < 1) return `"${field}" is out of range ${min}-${max}.`;
    }
  }
  return undefined;
}

/** The values a cron field allows, e.g. "1-5" → {1,2,3,4,5}. Assumes `cronProblem` passed. */
function cronValues(field: string, index: number): Set<number> {
  const [min, max] = CRON_FIELDS[index];
  const values = new Set<number>();
  for (const part of field.split(",")) {
    const match = /^(\*|(\d+)(?:-(\d+))?)(?:\/(\d+))?$/.exec(part)!;
    const from = match[2] === undefined ? min : Number(match[2]);
    // "5/15" means from 5 to the end, as in Vixie cron.
    const to = match[3] !== undefined ? Number(match[3]) : match[2] === undefined || match[4] !== undefined ? max : from;
    for (let value = from; value <= to; value += Number(match[4] ?? 1)) values.add(index === 4 && value === 7 ? 0 : value);
  }
  return values;
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const zoneFormats = new Map<string, Intl.DateTimeFormat>();

/** Whether `expression` names the minute of `at` in `timezone`. Day of month and weekday follow
 *  cron: when both are restricted, either one matching is enough. */
export function cronMatches(expression: string, timezone: string, at: Date): boolean {
  let format = zoneFormats.get(timezone);
  if (!format) {
    format = new Intl.DateTimeFormat("en-US", { timeZone: timezone, hourCycle: "h23", weekday: "short",
      month: "numeric", day: "numeric", hour: "numeric", minute: "numeric" });
    zoneFormats.set(timezone, format);
  }
  const parts = Object.fromEntries(format.formatToParts(at).map((part) => [part.type, part.value]));
  const fields = expression.trim().split(/\s+/);
  const local = [Number(parts.minute), Number(parts.hour), Number(parts.day), Number(parts.month), WEEKDAYS.indexOf(parts.weekday)];
  const hit = fields.map((field, index) => cronValues(field, index).has(local[index]));
  const day = fields[2].startsWith("*") || fields[4].startsWith("*") ? hit[2] && hit[4] : hit[2] || hit[4];
  return hit[0] && hit[1] && hit[3] && day;
}

export function timezoneProblem(timezone: string): string | undefined {
  try { new Intl.DateTimeFormat("en", { timeZone: timezone }); return undefined; }
  catch { return `"${timezone}" is not an IANA timezone, e.g. Asia/Shanghai.`; }
}

const DAY = 86_400_000;
const MINUTE = 60_000;

/** The next scheduled minute, strictly after `after`, within 366 days. This describes a plan,
 * not a wake-up guarantee. Enumerating local dates avoids scanning half a million minutes.
 * Nearby zone offsets generate both occurrences of a repeated time; round trips discard
 * nonexistent spring-forward times. The same cron matcher remains authoritative. */
export function nextCronOccurrence(expression: string, timezone: string, after: number): number | undefined {
  if (!Number.isFinite(after) || cronProblem(expression) || timezoneProblem(timezone)) return undefined;
  const fields = expression.trim().split(/\s+/);
  const values = fields.map(cronValues);
  const format = new Intl.DateTimeFormat("en-US", { timeZone: timezone, hourCycle: "h23",
    year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric" });
  const localStamp = (time: number) => {
    const parts = Object.fromEntries(format.formatToParts(time).map(part => [part.type, part.value]));
    return Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour), Number(parts.minute));
  };
  const firstDay = Math.floor(localStamp(after) / DAY) * DAY;
  const limit = after + 366 * DAY;
  const hours = [...values[1]].sort((a, b) => a - b), minutes = [...values[0]].sort((a, b) => a - b);
  for (let date = firstDay; date <= limit + DAY; date += DAY) {
    const day = new Date(date);
    if (!values[3].has(day.getUTCMonth() + 1)) continue;
    const monthDay = values[2].has(day.getUTCDate()), weekDay = values[4].has(day.getUTCDay());
    if (!(fields[2].startsWith("*") || fields[4].startsWith("*") ? monthDay && weekDay : monthDay || weekDay)) continue;
    // Include either side of offset transitions, including half-hour shifts and skipped dates.
    const offsets = new Set([-DAY, 0, DAY / 2, DAY, 2 * DAY].map(delta => localStamp(date + delta) - (date + delta)));
    let earliest: number | undefined;
    for (const hour of hours) for (const minute of minutes) {
      const local = date + hour * 60 * MINUTE + minute * MINUTE;
      for (const offset of offsets) {
        const candidate = local - offset;
        if (candidate <= after || candidate > limit || earliest !== undefined && candidate >= earliest) continue;
        if (localStamp(candidate) === local && cronMatches(expression, timezone, new Date(candidate))) earliest = candidate;
      }
    }
    if (earliest !== undefined) return earliest;
  }
  return undefined;
}

/** Common schedules are readable; arbitrary cron stays explicit rather than being guessed. */
export function routineScheduleLabel(expression: string, locale: string): string {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5 || cronProblem(expression)) return expression;
  const [minute, hour, day, month, weekday] = fields;
  const zh = locale === "zh", ja = locale === "ja";
  if (day !== "*" || month !== "*") return expression;
  if (/^\d+$/.test(minute) && /^\d+$/.test(hour)) {
    const time = `${hour.padStart(2, "0")}:${minute.padStart(2, "0")}`;
    if (weekday === "*") return `${zh ? "每天" : ja ? "毎日" : "Daily"} ${time}`;
    if (weekday === "1-5") return `${zh ? "工作日" : ja ? "平日" : "Weekdays"} ${time}`;
    if (/^[0-7]$/.test(weekday)) {
      const name = (zh ? ["周日", "周一", "周二", "周三", "周四", "周五", "周六"] : ja
        ? ["日曜日", "月曜日", "火曜日", "水曜日", "木曜日", "金曜日", "土曜日"]
        : ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"])[Number(weekday) % 7];
      return `${zh ? "每" : ja ? "毎週" : "Every "}${name} ${time}`;
    }
  }
  if (weekday === "*" && hour === "*" && /^\d+$/.test(minute)) return zh ? `每小时 ${minute.padStart(2, "0")} 分` : ja ? `毎時 ${minute.padStart(2, "0")} 分` : `Hourly at :${minute.padStart(2, "0")}`;
  return expression;
}
