import { configInvalid } from "@etl-js/contracts";

/**
 * Interprete minimo di formati data. Non usa una libreria perche' servono
 * pochi token e ci serve un errore chiaro quando un flusso scrive "gg/mm/aaaa"
 * invece di "dd/MM/yyyy".
 */
interface Token {
  pattern: string;
  regex: string;
  part: "year" | "year2" | "month" | "day" | "hour" | "minute" | "second" | "week" | "literal";
}

// L'ordine conta: i token piu' lunghi vanno provati per primi.
const TOKENS: Token[] = [
  { pattern: "yyyy", regex: "(\\d{4})", part: "year" },
  { pattern: "yy", regex: "(\\d{2})", part: "year2" },
  { pattern: "MM", regex: "(\\d{2})", part: "month" },
  { pattern: "M", regex: "(\\d{1,2})", part: "month" },
  { pattern: "dd", regex: "(\\d{2})", part: "day" },
  { pattern: "d", regex: "(\\d{1,2})", part: "day" },
  { pattern: "HH", regex: "(\\d{2})", part: "hour" },
  { pattern: "H", regex: "(\\d{1,2})", part: "hour" },
  { pattern: "mm", regex: "(\\d{2})", part: "minute" },
  { pattern: "m", regex: "(\\d{1,2})", part: "minute" },
  { pattern: "ss", regex: "(\\d{2})", part: "second" },
  { pattern: "s", regex: "(\\d{1,2})", part: "second" },
  { pattern: "ww", regex: "(\\d{2})", part: "week" },
  { pattern: "w", regex: "(\\d{1,2})", part: "week" },
  // Il designatore ISO delle settimane: "2026-W07".
  { pattern: "W", regex: "W", part: "literal" },
];

export interface CompiledFormat {
  source: string;
  regex: RegExp;
  parts: Exclude<Token["part"], "literal">[];
}

/** Compila un formato una volta sola; e' il chiamante a tenerne la cache. */
export function compileFormat(format: string, plugin = "cast"): CompiledFormat {
  let regex = "^";
  const parts: CompiledFormat["parts"] = [];
  let i = 0;

  while (i < format.length) {
    const token = TOKENS.find((candidate) => format.startsWith(candidate.pattern, i));
    if (token) {
      regex += token.regex;
      if (token.part !== "literal") parts.push(token.part);
      i += token.pattern.length;
      continue;
    }
    const char = format.charAt(i);
    if (/[a-zA-Z]/.test(char)) {
      throw configInvalid(plugin, [
        {
          path: "format",
          message: `"${char}" non e' un segnaposto valido in "${format}". Usa yyyy, MM, dd, HH, mm, ss, ww`,
        },
      ]);
    }
    regex += char.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    i += 1;
  }

  if (parts.length === 0) {
    throw configInvalid(plugin, [
      { path: "format", message: `il formato "${format}" non contiene alcun segnaposto` },
    ]);
  }

  return { source: format, regex: new RegExp(`${regex}$`), parts };
}

export interface DateParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  week?: number;
}

/** Estrae i pezzi, senza ancora giudicare se la data esista. */
export function matchFormat(format: CompiledFormat, text: string): DateParts | undefined {
  const match = format.regex.exec(text.trim());
  if (!match) return undefined;

  const parts: DateParts = { year: 1970, month: 1, day: 1, hour: 0, minute: 0, second: 0 };
  format.parts.forEach((part, index) => {
    const value = Number(match[index + 1]);
    switch (part) {
      case "year":
        parts.year = value;
        break;
      case "year2":
        // Finestra mobile: 00-68 -> 2000-2068, 69-99 -> 1969-1999.
        parts.year = value <= 68 ? 2000 + value : 1900 + value;
        break;
      case "month":
        parts.month = value;
        break;
      case "day":
        parts.day = value;
        break;
      case "hour":
        parts.hour = value;
        break;
      case "minute":
        parts.minute = value;
        break;
      case "second":
        parts.second = value;
        break;
      case "week":
        parts.week = value;
        break;
    }
  });
  return parts;
}

function pad(value: number, width = 2): string {
  return String(value).padStart(width, "0");
}

/**
 * Verifica che la data esista davvero: il 31 febbraio non deve diventare
 * il 3 marzo, come farebbe `new Date`.
 */
export function toIsoDate(parts: DateParts): string | undefined {
  const { year, month, day } = parts;
  if (month < 1 || month > 12 || day < 1 || day > 31) return undefined;
  const utc = new Date(Date.UTC(year, month - 1, day));
  if (
    utc.getUTCFullYear() !== year ||
    utc.getUTCMonth() !== month - 1 ||
    utc.getUTCDate() !== day
  ) {
    return undefined;
  }
  return `${pad(year, 4)}-${pad(month)}-${pad(day)}`;
}

/** Data e ora senza fuso: e' cio' che c'e' scritto nel file, niente di piu'. */
export function toIsoDateTime(parts: DateParts): string | undefined {
  const date = toIsoDate(parts);
  if (!date) return undefined;
  if (parts.hour > 23 || parts.minute > 59 || parts.second > 59) return undefined;
  return `${date}T${pad(parts.hour)}:${pad(parts.minute)}:${pad(parts.second)}`;
}

const DAY_MS = 86_400_000;

/** Quante settimane ISO ha un anno: 52, o 53 quando l'anno "sfora". */
export function isoWeeksInYear(year: number): number {
  const dayOfWeek = (y: number, month: number, day: number): number =>
    (new Date(Date.UTC(y, month, day)).getUTCDay() + 6) % 7;
  const startsThursday = dayOfWeek(year, 0, 1) === 3;
  const isLeap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  const leapStartsWednesday = isLeap && dayOfWeek(year, 0, 1) === 2;
  return startsThursday || leapStartsWednesday ? 53 : 52;
}

/**
 * Il lunedi' di una settimana ISO 8601. La settimana 1 e' quella che contiene
 * il 4 gennaio, per cui la settimana 1 del 2026 comincia il 29 dicembre 2025:
 * un file di dati "settimana 1" non e' un piano di gennaio.
 */
export function isoWeekMonday(year: number, week: number): string | undefined {
  if (!Number.isInteger(week) || week < 1 || week > isoWeeksInYear(year)) return undefined;
  const jan4 = Date.UTC(year, 0, 4);
  const dayOfWeek = (new Date(jan4).getUTCDay() + 6) % 7;
  const firstMonday = jan4 - dayOfWeek * DAY_MS;
  const monday = new Date(firstMonday + (week - 1) * 7 * DAY_MS);
  return `${pad(monday.getUTCFullYear(), 4)}-${pad(monday.getUTCMonth() + 1)}-${pad(monday.getUTCDate())}`;
}
