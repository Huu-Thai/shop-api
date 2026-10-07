/** Machine codes: lower case, digits, `-` and `_`, starting with a letter (stores, attributes…). */
export const CODE_PATTERN = /^[a-z][a-z0-9_-]{0,63}$/;
export const CODE_MESSAGE =
  'must be lower case letters, digits, "-" or "_", starting with a letter (max 64)';
/** BCP 47 subset used for locales: `en`, `en-US`, `zh-Hant-TW`, `es-419`. */
export const LOCALE_PATTERN =
  /^[a-z]{2,3}(-[A-Z][a-z]{3})?(-[A-Z]{2}|-[0-9]{3})?$/;
export const CURRENCY_PATTERN = /^[A-Z]{3}$/;
export const COUNTRY_PATTERN = /^[A-Z]{2}$/;
