const monthNames = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
] as const;
const weekdayNames = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
] as const;

interface ZonedParts {
  day: string;
  hour: string;
  minute: string;
  month: string;
  offset: string;
  period: string;
  weekday: string;
  year: string;
}

function utcDate(
  year: number,
  month: number,
  day: number,
  hour = 0,
  minute = 0,
  second = 0,
): Date {
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  date.setUTCHours(hour, minute, second, 0);
  return date;
}

function partValue(
  parts: readonly Intl.DateTimeFormatPart[],
  type: Intl.DateTimeFormatPartTypes,
): string {
  const value = parts.find((part) => part.type === type)?.value;
  if (!value) throw new Error(`Timezone formatter omitted ${type}.`);
  return value;
}

function zonedParts(instant: string, timezone: string): ZonedParts {
  const date = new Date(instant);
  if (!Number.isFinite(date.valueOf())) {
    throw new TypeError("Calendar time must be a valid instant.");
  }
  const parts = new Intl.DateTimeFormat("en-US", {
    day: "2-digit",
    hour: "2-digit",
    hourCycle: "h23",
    minute: "2-digit",
    month: "2-digit",
    second: "2-digit",
    timeZone: timezone,
    year: "numeric",
  }).formatToParts(date);
  const day = Number(partValue(parts, "day"));
  const hour = Number(partValue(parts, "hour"));
  const minute = Number(partValue(parts, "minute"));
  const month = Number(partValue(parts, "month"));
  const second = Number(partValue(parts, "second"));
  const year = Number(partValue(parts, "year"));
  const localAsUtc = utcDate(year, month, day, hour, minute, second).valueOf();
  const instantAtSecond = Math.floor(date.valueOf() / 1_000) * 1_000;
  const offsetMinutes = Math.round((localAsUtc - instantAtSecond) / 60_000);
  const offsetSign = offsetMinutes < 0 ? "-" : "+";
  const absoluteOffset = Math.abs(offsetMinutes);
  const offsetHour = Math.floor(absoluteOffset / 60)
    .toString()
    .padStart(2, "0");
  const offsetMinute = (absoluteOffset % 60).toString().padStart(2, "0");
  const monthName = monthNames[month - 1];
  const weekday = weekdayNames[utcDate(year, month, day).getUTCDay()];
  if (!monthName || !weekday) {
    throw new Error("Timezone formatter produced an invalid local date.");
  }
  return {
    day: day.toString(),
    hour: (hour % 12 || 12).toString(),
    minute: minute.toString().padStart(2, "0"),
    month: monthName,
    offset: `UTC${offsetSign}${offsetHour}:${offsetMinute}`,
    period: hour < 12 ? "AM" : "PM",
    weekday,
    year: year.toString(),
  };
}

function display(parts: ZonedParts): string {
  return `${parts.weekday}, ${parts.month} ${parts.day}, ${parts.year} at ${parts.hour}:${parts.minute} ${parts.period}`;
}

export function isIanaTimezone(value: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value }).format(0);
    return value.includes("/") || value === "UTC";
  } catch {
    return false;
  }
}

export function eventZoneHumanTime(
  startAt: string,
  endAt: string,
  timezone: string,
): string {
  if (!isIanaTimezone(timezone)) {
    throw new TypeError("Calendar timezone must be a valid IANA timezone.");
  }
  if (Date.parse(startAt) >= Date.parse(endAt)) {
    throw new TypeError("Calendar event must end after it starts.");
  }
  const start = zonedParts(startAt, timezone);
  const end = zonedParts(endAt, timezone);
  const offsets =
    start.offset === end.offset
      ? start.offset
      : `${start.offset} to ${end.offset}`;
  return `${display(start)} - ${display(end)} (${timezone}; ${offsets})`;
}

export function allDayHumanTime(
  startDate: string,
  endDateExclusive: string,
  timezone: string,
): string {
  if (!isIanaTimezone(timezone)) {
    throw new TypeError("Calendar timezone must be a valid IANA timezone.");
  }
  const date = (value: string) => new Date(`${value}T00:00:00Z`);
  const validDate = (value: string) => {
    const parsed = date(value);
    return (
      /^\d{4}-\d{2}-\d{2}$/u.test(value) &&
      Number.isFinite(parsed.valueOf()) &&
      parsed.toISOString().slice(0, 10) === value
    );
  };
  if (
    !validDate(startDate) ||
    !validDate(endDateExclusive) ||
    startDate >= endDateExclusive
  ) {
    throw new TypeError(
      "All-day end date must be exclusive and after its valid start date.",
    );
  }
  const start = date(startDate);
  const inclusiveEnd = date(endDateExclusive);
  inclusiveEnd.setUTCDate(inclusiveEnd.getUTCDate() - 1);
  const startWeekday = weekdayNames[start.getUTCDay()];
  const startMonth = monthNames[start.getUTCMonth()];
  const endWeekday = weekdayNames[inclusiveEnd.getUTCDay()];
  const endMonth = monthNames[inclusiveEnd.getUTCMonth()];
  const startText = `${startWeekday}, ${startMonth} ${start.getUTCDate()}, ${start.getUTCFullYear()}`;
  const endText = `${endWeekday}, ${endMonth} ${inclusiveEnd.getUTCDate()}, ${inclusiveEnd.getUTCFullYear()}`;
  return `${startText}${startDate === inclusiveEnd.toISOString().slice(0, 10) ? "" : ` - ${endText}`} (all day; ${timezone})`;
}
