/**
 * Comprehensive Automated Test Suite for IBAN Validator (ISO 13616 & MOD-97)
 */

const { validateIBAN, normalizeIBAN, maskIBAN, formatIBAN } = require('./src/utils/ibanValidator');

const testCases = [
  // 1. Valid IBAN Tests across multiple countries
  {
    name: 'Valid Spanish IBAN (User Prompt Example)',
    iban: 'ES9121000418450200051332',
    expectedValid: true,
    expectedCountry: 'ES'
  },
  {
    name: 'Valid Spanish IBAN with lowercase and spaces',
    iban: '  es91 2100 0418 4502 0005 1332  ',
    expectedValid: true,
    expectedCountry: 'ES',
    expectedNormalized: 'ES9121000418450200051332'
  },
  {
    name: 'Valid German IBAN (DE)',
    iban: 'DE89370400440532013000',
    expectedValid: true,
    expectedCountry: 'DE'
  },
  {
    name: 'Valid French IBAN (FR)',
    iban: 'FR1420041010050500013M02606',
    expectedValid: true,
    expectedCountry: 'FR'
  },
  {
    name: 'Valid United Kingdom IBAN (GB)',
    iban: 'GB29NWBK60161331926819',
    expectedValid: true,
    expectedCountry: 'GB'
  },
  {
    name: 'Valid UAE IBAN (AE)',
    iban: 'AE070331234567890123456',
    expectedValid: true,
    expectedCountry: 'AE'
  },
  {
    name: 'Valid Netherlands IBAN (NL)',
    iban: 'NL91ABNA0417164300',
    expectedValid: true,
    expectedCountry: 'NL'
  },
  {
    name: 'Valid Italian IBAN (IT)',
    iban: 'IT60X0542811101000000123456',
    expectedValid: true,
    expectedCountry: 'IT'
  },
  {
    name: 'Valid Swiss IBAN (CH)',
    iban: 'CH9300762011623852957',
    expectedValid: true,
    expectedCountry: 'CH'
  },

  // 2. Invalid IBAN Tests
  {
    name: 'Invalid Checksum (Altered last digit of valid ES IBAN)',
    iban: 'ES9121000418450200051333',
    expectedValid: false,
    expectedErrorMatch: /checksum/i
  },
  {
    name: 'Invalid Country Code (Unsupported/Fake ZZ)',
    iban: 'ZZ9121000418450200051332',
    expectedValid: false,
    expectedErrorMatch: /country/i
  },
  {
    name: 'Invalid Length (Too short for Spain)',
    iban: 'ES123456789',
    expectedValid: false,
    expectedErrorMatch: /length/i
  },
  {
    name: 'Invalid Length (Too long for Germany)',
    iban: 'DE8937040044053201300099999',
    expectedValid: false,
    expectedErrorMatch: /length/i
  },
  {
    name: 'Invalid Characters (Contains special symbols @)',
    iban: 'ES912100041845020005133@',
    expectedValid: false,
    expectedErrorMatch: /characters/i
  },
  {
    name: 'Invalid Characters (Contains punctuation !)',
    iban: 'ES912100041845020005133!',
    expectedValid: false,
    expectedErrorMatch: /characters/i
  },
  {
    name: 'Empty String IBAN',
    iban: '',
    expectedValid: false,
    expectedErrorMatch: /required/i
  },
  {
    name: 'Whitespace Only IBAN',
    iban: '    ',
    expectedValid: false,
    expectedErrorMatch: /required/i
  },
  {
    name: 'Null IBAN',
    iban: null,
    expectedValid: false,
    expectedErrorMatch: /required/i
  }
];

console.log('====================================================');
console.log('🧪 RUNNING IBAN VALIDATION TEST SUITE');
console.log('====================================================\n');

let passedCount = 0;
let failedCount = 0;

testCases.forEach((tc, index) => {
  const result = validateIBAN(tc.iban);
  let isPass = result.valid === tc.expectedValid;

  if (tc.expectedCountry && result.countryCode !== tc.expectedCountry) {
    isPass = false;
  }
  if (tc.expectedNormalized && result.normalizedIBAN !== tc.expectedNormalized) {
    isPass = false;
  }
  if (tc.expectedErrorMatch && (!result.error || !tc.expectedErrorMatch.test(result.error))) {
    isPass = false;
  }

  if (isPass) {
    passedCount++;
    console.log(`✅ [PASS] #${index + 1}: ${tc.name}`);
    if (result.valid) {
      console.log(`   Normalized: ${result.normalizedIBAN} | Country: ${result.countryCode} | Masked: ${result.maskedIBAN}`);
    } else {
      console.log(`   Error Caught: "${result.error}"`);
    }
  } else {
    failedCount++;
    console.error(`❌ [FAIL] #${index + 1}: ${tc.name}`);
    console.error(`   Input: ${JSON.stringify(tc.iban)}`);
    console.error(`   Result:`, result);
  }
  console.log('----------------------------------------------------');
});

// Test Masking
console.log('\n🔒 TESTING IBAN MASKING UTILITY');
const testMask = maskIBAN('ES9121000418450200051332');
const isMaskCorrect = testMask === 'ES91 **** **** **** **** 1332';
console.log(`Masked Output: "${testMask}" -> ${isMaskCorrect ? '✅ PASS' : '❌ FAIL'}`);

// Test Formatting
console.log('\n📄 TESTING IBAN 4-CHAR BLOCK FORMATTER');
const testFormat = formatIBAN('ES9121000418450200051332');
const isFormatCorrect = testFormat === 'ES91 2100 0418 4502 0005 1332';
console.log(`Formatted Output: "${testFormat}" -> ${isFormatCorrect ? '✅ PASS' : '❌ FAIL'}`);

let finalFailed = failedCount + (isMaskCorrect ? 0 : 1) + (isFormatCorrect ? 0 : 1);
let finalPassed = passedCount + (isMaskCorrect ? 1 : 0) + (isFormatCorrect ? 1 : 0);

console.log('\n====================================================');
console.log(`🏁 TEST RUN FINISHED: ${finalPassed} PASSED, ${finalFailed} FAILED`);
console.log('====================================================\n');

if (finalFailed > 0) {
  process.exit(1);
} else {
  process.exit(0);
}
