/**
 * 当地时间规则。
 *
 * 业务约定（见 README「时间规则」）：
 * - 所有衔接比较同时基于绝对时刻（Date）与 IANA 时区下的当地分量；
 * - 跨时区连接的最短衔接时间按绝对分钟计算（时钟不会倒着走）；
 * - 跨午夜连接（红眼/凌晨到达）按酒店当地营业日判定：
 *   凌晨 nightCutoff（默认 04:00）之前的到达仍计入前一营业日的那晚住房；
 * - 事件中持久化 local 字符串只是 at+tz 的投影，禁止拿两个 local 字符串直接相减。
 */

function partsInZone(instant, tz) {
  // en-CA 日历给出稳定的 YYYY-MM-DD 与时分字段，分量取自指定 IANA 时区
  const f = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  const m = Object.fromEntries(f.formatToParts(instant).map((p) => [p.type, p.value]));
  return {
    year: Number(m.year),
    month: Number(m.month),
    day: Number(m.day),
    hour: Number(m.hour),
    minute: Number(m.minute),
  };
}

export function asInstant(value) {
  return value instanceof Date ? value : new Date(value);
}

export function localDateTime(instant, tz) {
  const p = partsInZone(instant, tz);
  const pad = (n) => String(n).padStart(2, "0");
  return `${p.year}-${pad(p.month)}-${pad(p.day)}T${pad(p.hour)}:${pad(p.minute)}`;
}

export function localDate(instant, tz) {
  return localDateTime(instant, tz).slice(0, 10);
}

export function localMinutesSinceMidnight(instant, tz) {
  const p = partsInZone(instant, tz);
  return p.hour * 60 + p.minute;
}

/** 绝对分钟差：b - a。跨时区、跨夏令时都安全。 */
export function gapMinutes(a, b) {
  return Math.round((asInstant(b).getTime() - asInstant(a).getTime()) / 60000);
}

/**
 * 到达是否仍属于前一营业日的那晚（跨午夜连接）。
 * 例如酒店入住日为 10-01、住一晚，航班 10-02 01:30 才落地，
 * 在 04:00 夜切截止前仍使用 10-01 那晚的房间，不算新增一晚。
 */
export function belongsToPreviousServiceNight(arrival, tz, serviceDate, nightCutoffMinutes = 4 * 60) {
  const [sy, sm, sd] = serviceDate.split("-").map(Number);
  const next = new Date(Date.UTC(sy, sm - 1, sd + 1));
  const nextDay = `${next.getUTCFullYear()}-${String(next.getUTCMonth() + 1).padStart(2, "0")}-${String(
    next.getUTCDate()
  ).padStart(2, "0")}`;
  const date = localDate(asInstant(arrival), tz);
  return date === nextDay && localMinutesSinceMidnight(asInstant(arrival), tz) < nightCutoffMinutes;
}

/** 最短衔接时间（MCT）是否满足；按绝对分钟。 */
export function meetsMinimumConnection(arrival, departure, mctMinutes) {
  return gapMinutes(arrival, departure) >= mctMinutes;
}

/** 把绝对时刻投影成事件负载里的 local_instant 形状。 */
export function zoned(instant, tz) {
  const d = asInstant(instant);
  return { at: d.toISOString(), tz, local: localDateTime(d, tz) };
}
