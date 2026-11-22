import { toDay } from './selector';

/*
 * 日本語の日付表現を YYYY-MM-DD にする（AIなし）。基準日は日本時間。
 *   今日 / 明日 / 明後日 / 3日後 / 2週間後 / 1か月後 / 来週金曜 / 金曜まで / 12/5 / 11月25日 / 2026-12-01 / 月末 / 来月5日 / 25日まで
 */

export const addDays = (day: string, n: number): string => {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

const addMonths = (day: string, n: number): string => {
  const [y, m, dd] = day.split('-').map(Number);
  const last = new Date(Date.UTC(y, m - 1 + n + 1, 0)).getUTCDate();
  return new Date(Date.UTC(y, m - 1 + n, Math.min(dd, last))).toISOString().slice(0, 10);
};

const endOfMonth = (day: string, n: number): string => {
  const [y, m] = day.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1 + n + 1, 0)).toISOString().slice(0, 10);
};

const ymd = (y: number, m: number, d: number): string | null => {
  const t = new Date(Date.UTC(y, m - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d ? t.toISOString().slice(0, 10) : null;
};

const WD = '日月火水木金土';
/** 月曜始まりの週の月曜日 */
const mondayOf = (day: string) => {
  const dow = new Date(`${day}T00:00:00Z`).getUTCDay();
  return addDays(day, -((dow + 6) % 7));
};
const weekdayOffsetFromMonday = (ch: string) => (WD.indexOf(ch) + 6) % 7;

export interface ParsedDate {
  date: string;
  text: string; // 日付として読み取った部分
}

export function parseDateJa(input: string, base: Date | string): ParsedDate | null {
  const today = typeof base === 'string' ? base : toDay(base);
  if (!today) return null;
  const [by, bm] = today.split('-').map(Number);
  let m: RegExpMatchArray | null;

  // 2026-12-01 / 2026/12/1 / 2026年12月1日
  if ((m = input.match(/(\d{4})[-/年](\d{1,2})[-/月](\d{1,2})日?/))) {
    const d = ymd(Number(m[1]), Number(m[2]), Number(m[3]));
    if (d) return { date: d, text: m[0] };
  }
  // 11月25日 / 12/5（今年。かなり過去になるなら来年）
  if ((m = input.match(/(?<![\d/])(\d{1,2})月(\d{1,2})日/)) || (m = input.match(/(?<![\d/])(\d{1,2})\/(\d{1,2})(?![\d/])/))) {
    let d = ymd(by, Number(m[1]), Number(m[2]));
    if (d && d < addDays(today, -60)) d = ymd(by + 1, Number(m[1]), Number(m[2]));
    if (d) return { date: d, text: m[0] };
  }
  // 月末
  if ((m = input.match(/(今月|来月|再来月)?の?月末/))) {
    const off = m[1] === '来月' ? 1 : m[1] === '再来月' ? 2 : 0;
    return { date: endOfMonth(today, off), text: m[0] };
  }
  // 来月5日
  if ((m = input.match(/(来月|再来月)の?(\d{1,2})日/))) {
    const [y, mo] = addMonths(`${by}-${String(bm).padStart(2, '0')}-01`, m[1] === '来月' ? 1 : 2).split('-').map(Number);
    const d = ymd(y, mo, Number(m[2]));
    if (d) return { date: d, text: m[0] };
  }
  // 相対：明々後日 / 明後日 / 明日 / 今日
  if ((m = input.match(/明々後日|しあさって/))) return { date: addDays(today, 3), text: m[0] };
  if ((m = input.match(/明後日|あさって/))) return { date: addDays(today, 2), text: m[0] };
  if ((m = input.match(/明日|あした|あす/))) return { date: addDays(today, 1), text: m[0] };
  if ((m = input.match(/今日|本日|きょう/))) return { date: today, text: m[0] };
  if ((m = input.match(/(\d+)\s*日後/))) return { date: addDays(today, Number(m[1])), text: m[0] };
  if ((m = input.match(/(\d+)\s*週間後/))) return { date: addDays(today, Number(m[1]) * 7), text: m[0] };
  if ((m = input.match(/(\d+)\s*(?:か|ヶ|カ|ケ)月後/))) return { date: addMonths(today, Number(m[1])), text: m[0] };

  // 来週金曜 / 今週月曜 / 再来週水曜
  if ((m = input.match(/(再来週|来週|今週)の?([日月火水木金土])曜日?/))) {
    const wk = m[1] === '再来週' ? 2 : m[1] === '来週' ? 1 : 0;
    return { date: addDays(mondayOf(today), wk * 7 + weekdayOffsetFromMonday(m[2])), text: m[0] };
  }
  if ((m = input.match(/(今週|来週)(中|末)/))) {
    const wk = m[1] === '来週' ? 1 : 0;
    return { date: addDays(mondayOf(today), wk * 7 + (m[2] === '中' ? 4 : 6)), text: m[0] };
  }
  // 金曜まで（今日を含む次の金曜）
  if ((m = input.match(/([日月火水木金土])曜日?/))) {
    const dow = new Date(`${today}T00:00:00Z`).getUTCDay();
    return { date: addDays(today, (WD.indexOf(m[1]) - dow + 7) % 7), text: m[0] };
  }
  // 25日まで（今月。過ぎていれば来月）
  if ((m = input.match(/(?<![\d月])(\d{1,2})日(?:まで|に|中)/))) {
    let d = ymd(by, bm, Number(m[1]));
    if (d && d < today) {
      const [y2, m2] = addMonths(`${by}-${String(bm).padStart(2, '0')}-01`, 1).split('-').map(Number);
      d = ymd(y2, m2, Number(m[1]));
    }
    if (d) return { date: d, text: m[0] };
  }
  return null;
}
