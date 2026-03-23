/**
 * Name normalization utilities for fuzzy deduplication.
 */

const UNICODE_MAP: Record<string, string> = {
  à: "a", á: "a", â: "a", ã: "a", ä: "a", å: "a", æ: "ae",
  ç: "c",
  è: "e", é: "e", ê: "e", ë: "e",
  ì: "i", í: "i", î: "i", ï: "i",
  ð: "d",
  ñ: "n",
  ò: "o", ó: "o", ô: "o", õ: "o", ö: "o", ø: "o",
  ù: "u", ú: "u", û: "u", ü: "u",
  ý: "y", ÿ: "y",
  ß: "ss",
  þ: "th",
  ž: "z", ź: "z", ż: "z",
  š: "s", ś: "s",
  č: "c", ć: "c",
  ř: "r",
  ň: "n", ń: "n",
  ď: "d", đ: "d",
  ť: "t",
  ľ: "l", ł: "l",
  ą: "a",
  ę: "e",
  ő: "o",
  ű: "u",
};

/**
 * Normalize a name for fuzzy matching:
 * - Lowercase
 * - Strip leading "The "
 * - Transliterate common unicode variants
 * - Strip punctuation
 * - Collapse whitespace
 * - Trim
 */
export function normalizeName(name: string): string {
  let result = name.toLowerCase();

  // Strip leading "the "
  result = result.replace(/^the(\s+|$)/, "");

  // Transliterate unicode characters
  result = result
    .split("")
    .map((ch) => UNICODE_MAP[ch] ?? ch)
    .join("");

  // Strip punctuation (keep letters, numbers, whitespace)
  result = result.replace(/[^\p{L}\p{N}\s]/gu, "");

  // Collapse whitespace
  result = result.replace(/\s+/g, " ").trim();

  return result;
}
