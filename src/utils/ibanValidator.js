/**
 * Official IBAN Validator Utility (ISO 13616 & ISO 7064 MOD-97)
 * 
 * Provides structural, country-code, length, and checksum validation for IBANs.
 * Note: Checksum validation proves mathematical and structural validity, but does not
 * guarantee the account is active or belongs to a specific client.
 */

// Official ISO 13616 IBAN Country Registry Lengths
const IBAN_COUNTRY_LENGTHS = {
  AL: 28, // Albania
  AD: 24, // Andorra
  AT: 20, // Austria
  AZ: 28, // Azerbaijan
  BH: 22, // Bahrain
  BY: 28, // Belarus
  BE: 16, // Belgium
  BA: 20, // Bosnia and Herzegovina
  BR: 29, // Brazil
  BG: 22, // Bulgaria
  CR: 22, // Costa Rica
  HR: 21, // Croatia
  CY: 28, // Cyprus
  CZ: 24, // Czech Republic
  DK: 18, // Denmark
  DO: 28, // Dominican Republic
  TL: 23, // East Timor
  EG: 29, // Egypt
  EE: 20, // Estonia
  FO: 18, // Faroe Islands
  FI: 18, // Finland
  FR: 27, // France
  GE: 22, // Georgia
  DE: 22, // Germany
  GI: 23, // Gibraltar
  GR: 27, // Greece
  GL: 18, // Greenland
  GT: 28, // Guatemala
  HU: 28, // Hungary
  IS: 26, // Iceland
  IQ: 23, // Iraq
  IE: 22, // Ireland
  IL: 23, // Israel
  IT: 27, // Italy
  JO: 30, // Jordan
  KZ: 20, // Kazakhstan
  XK: 20, // Kosovo
  KW: 30, // Kuwait
  LV: 21, // Latvia
  LB: 28, // Lebanon
  LI: 21, // Liechtenstein
  LT: 20, // Lithuania
  LU: 20, // Luxembourg
  MK: 19, // North Macedonia
  MT: 31, // Malta
  MR: 27, // Mauritania
  MU: 30, // Mauritius
  MD: 24, // Moldova
  MC: 27, // Monaco
  ME: 22, // Montenegro
  NL: 18, // Netherlands
  NO: 15, // Norway
  PK: 24, // Pakistan
  PS: 29, // Palestine
  PL: 28, // Poland
  PT: 25, // Portugal
  QA: 29, // Qatar
  RO: 24, // Romania
  LC: 32, // Saint Lucia
  SM: 27, // San Marino
  ST: 25, // Sao Tome and Principe
  SA: 24, // Saudi Arabia
  RS: 22, // Serbia
  SC: 31, // Seychelles
  SK: 24, // Slovakia
  SI: 19, // Slovenia
  ES: 24, // Spain
  SE: 24, // Sweden
  CH: 21, // Switzerland
  TN: 24, // Tunisia
  TR: 26, // Turkey
  UA: 29, // Ukraine
  AE: 23, // United Arab Emirates
  GB: 22, // United Kingdom
  VA: 22, // Vatican City
  VG: 24  // British Virgin Islands
};

/**
 * Piecewise MOD-97 calculation to avoid 64-bit float precision limits
 * @param {string} numericString 
 * @returns {number} remainder
 */
function calculateMod97(numericString) {
  let remainder = 0;
  for (let i = 0; i < numericString.length; i += 7) {
    const block = remainder + numericString.substring(i, i + 7);
    remainder = String(parseInt(block, 10) % 97);
  }
  return parseInt(remainder, 10);
}

/**
 * Normalizes an IBAN by removing spaces, dashes, and converting to uppercase.
 * @param {string} rawIBAN 
 * @returns {string}
 */
function normalizeIBAN(rawIBAN) {
  if (!rawIBAN || typeof rawIBAN !== 'string') return '';
  return rawIBAN.replace(/[\s\-_.]/g, '').toUpperCase();
}

/**
 * Validates an IBAN structurally, by length, and via ISO 7064 MOD-97 checksum.
 * @param {string} rawIBAN 
 * @returns {{
 *   valid: boolean,
 *   normalizedIBAN: string,
 *   countryCode?: string,
 *   maskedIBAN?: string,
 *   error?: string
 * }}
 */
function validateIBAN(rawIBAN) {
  if (!rawIBAN || typeof rawIBAN !== 'string' || rawIBAN.trim().length === 0) {
    return {
      valid: false,
      normalizedIBAN: '',
      error: 'IBAN is required'
    };
  }

  const normalized = normalizeIBAN(rawIBAN);

  // 1. Character format check: only uppercase A-Z and 0-9 allowed
  if (!/^[A-Z0-9]+$/.test(normalized)) {
    return {
      valid: false,
      normalizedIBAN: normalized,
      error: 'IBAN contains invalid characters'
    };
  }

  // 2. Minimum length check (shortest valid IBAN is 15 chars: Norway NO)
  if (normalized.length < 15 || normalized.length > 34) {
    return {
      valid: false,
      normalizedIBAN: normalized,
      error: 'IBAN length is invalid'
    };
  }

  // 3. Country code validation
  const countryCode = normalized.substring(0, 2);
  if (!/^[A-Z]{2}$/.test(countryCode)) {
    return {
      valid: false,
      normalizedIBAN: normalized,
      error: 'Invalid country code format'
    };
  }

  const expectedLength = IBAN_COUNTRY_LENGTHS[countryCode];
  if (!expectedLength) {
    return {
      valid: false,
      normalizedIBAN: normalized,
      countryCode,
      error: `Unsupported or invalid IBAN country code: ${countryCode}`
    };
  }

  // 4. Country-specific length validation
  if (normalized.length !== expectedLength) {
    return {
      valid: false,
      normalizedIBAN: normalized,
      countryCode,
      error: `Invalid IBAN length for ${countryCode}. Expected ${expectedLength} characters, received ${normalized.length}`
    };
  }

  // 5. Check digits must be numbers
  const checkDigits = normalized.substring(2, 4);
  if (!/^\d{2}$/.test(checkDigits)) {
    return {
      valid: false,
      normalizedIBAN: normalized,
      countryCode,
      error: 'IBAN check digits must be numeric'
    };
  }

  // Check digits cannot be '00', '01', or > '98'
  const checkDigitsNum = parseInt(checkDigits, 10);
  if (checkDigitsNum < 2 || checkDigitsNum > 98) {
    return {
      valid: false,
      normalizedIBAN: normalized,
      countryCode,
      error: 'Invalid IBAN check digits range'
    };
  }

  // 6. ISO 7064 MOD-97 checksum calculation:
  // Rearrange: Move first 4 characters (country + check digits) to the end
  const rearranged = normalized.substring(4) + normalized.substring(0, 4);

  // Convert letters to digits: A=10, B=11, ..., Z=35
  let numericString = '';
  for (let i = 0; i < rearranged.length; i++) {
    const char = rearranged[i];
    const code = char.charCodeAt(0);
    if (code >= 65 && code <= 90) {
      // A-Z
      numericString += (code - 55).toString();
    } else {
      // 0-9
      numericString += char;
    }
  }

  const mod = calculateMod97(numericString);
  if (mod !== 1) {
    return {
      valid: false,
      normalizedIBAN: normalized,
      countryCode,
      error: 'Invalid IBAN checksum'
    };
  }

  return {
    valid: true,
    normalizedIBAN: normalized,
    countryCode,
    maskedIBAN: maskIBAN(normalized)
  };
}

/**
 * Masks an IBAN for safe display/logging without exposing sensitive full account numbers.
 * Example: "ES9121000418450200051332" -> "ES91 **** **** **** 1332"
 * @param {string} rawIBAN 
 * @returns {string}
 */
function maskIBAN(rawIBAN) {
  const normalized = normalizeIBAN(rawIBAN);
  if (!normalized || normalized.length < 8) return '****';

  const prefix = normalized.substring(0, 4);
  const suffix = normalized.substring(normalized.length - 4);
  const middle = normalized.substring(4, normalized.length - 4);
  
  const maskedMiddle = middle.match(/.{1,4}/g)?.map(() => '****').join(' ') || '****';

  return `${prefix} ${maskedMiddle} ${suffix}`;
}

/**
 * Formats an IBAN into human-readable 4-character blocks.
 * Example: "ES9121000418450200051332" -> "ES91 2100 0418 4502 0005 1332"
 * @param {string} rawIBAN 
 * @returns {string}
 */
function formatIBAN(rawIBAN) {
  const normalized = normalizeIBAN(rawIBAN);
  if (!normalized) return '';
  return normalized.replace(/(.{4})/g, '$1 ').trim();
}

module.exports = {
  IBAN_COUNTRY_LENGTHS,
  normalizeIBAN,
  validateIBAN,
  maskIBAN,
  formatIBAN
};
