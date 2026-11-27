// Safe JSON parsing that preserves 16+ digit integer literals (exceeding JS
// Number.MAX_SAFE_INTEGER = 2^53 - 1) as strings before JSON.parse runs.

/**
 * Rewrite integer literals with 16 or more digits outside JSON string literals
 * into quoted strings so 64-bit numeric IDs do not lose precision in float64.
 */
export function quoteLargeIntegers(text) {
  const s = String(text);
  const len = s.length;
  let out = "";
  let lastFlush = 0;
  let i = 0;

  while (i < len) {
    const ch = s.charCodeAt(i);
    if (ch === 34 /* " */) {
      i++;
      while (i < len) {
        const c = s.charCodeAt(i);
        if (c === 92 /* \ */) {
          i += 2;
        } else if (c === 34 /* " */) {
          i++;
          break;
        } else {
          i++;
        }
      }
      continue;
    }

    if (ch === 45 /* - */ || (ch >= 48 && ch <= 57)) {
      const start = i;
      if (ch === 45) i++;
      const digitStart = i;
      while (i < len) {
        const d = s.charCodeAt(i);
        if (d >= 48 && d <= 57) i++;
        else break;
      }
      const digitCount = i - digitStart;
      let isFloat = false;
      if (i < len && s.charCodeAt(i) === 46 /* . */) {
        isFloat = true;
        i++;
        while (i < len) {
          const d = s.charCodeAt(i);
          if (d >= 48 && d <= 57) i++;
          else break;
        }
      }
      if (i < len && (s.charCodeAt(i) === 101 /* e */ || s.charCodeAt(i) === 69 /* E */)) {
        isFloat = true;
        i++;
        if (i < len && (s.charCodeAt(i) === 43 /* + */ || s.charCodeAt(i) === 45 /* - */)) {
          i++;
        }
        while (i < len) {
          const d = s.charCodeAt(i);
          if (d >= 48 && d <= 57) i++;
          else break;
        }
      }
      if (!isFloat && digitCount >= 16 && s.charCodeAt(digitStart) !== 48 /* '0' */) {
        out += s.slice(lastFlush, start) + '"' + s.slice(start, i) + '"';
        lastFlush = i;
      }
      continue;
    }

    i++;
  }

  if (lastFlush === 0) return s;
  return out + s.slice(lastFlush);
}

export function parseJSONSafe(text) {
  return JSON.parse(quoteLargeIntegers(text));
}
