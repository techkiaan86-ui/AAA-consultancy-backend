const { getDocumentProxy, extractText } = require('unpdf');

/**
 * Accurately counts words across ALL languages (English, Arabic, Urdu, Spanish, Hindi, French, German, Russian, etc.)
 * Ignores standalone symbols (|, -, #, @, etc.) and handles Unicode combining marks.
 */
function countWordsAccurately(text) {
  if (!text || typeof text !== 'string') return 0;
  
  // Clean zero-width space characters & control marks if any
  const cleaned = text.replace(/[\u200B-\u200D\uFEFF]/g, ' ');

  // \p{L} = Any Unicode Letter (Latin, Arabic, Urdu, Devanagari, Cyrillic, CJK, etc.)
  // \p{N} = Any Unicode Number (0-9, Arabic-Indic digits ٠-٩, Extended Urdu digits ۰-۹)
  // \p{M} = Unicode Combining Marks (Harakat / Diacritics like Zer/Zabar/Pesh)
  // Keeps intra-word apostrophes (e.g. don't, l'eau) while treating hyphens/dashes/symbols as word boundaries
  const wordRegex = /[\p{L}\p{N}\p{M}]+(?:['’][\p{L}\p{N}\p{M}]+)*/gu;
  
  const matches = cleaned.match(wordRegex);
  return matches ? matches.length : 0;
}

/**
 * Extracts text from PDF buffer with spatial gap detection.
 * In RTL/Arabic/Urdu PDFs, word spaces are often rendered as horizontal positioning shifts (TJ/Tj)
 * without explicit ASCII space characters. This function inserts spaces where spatial gaps exist between items.
 */
async function extractPdfTextPositionAware(fileBuffer) {
  try {
    if (!fileBuffer || fileBuffer.length === 0) return '';
    const uint8Array = new Uint8Array(fileBuffer);
    const pdf = await getDocumentProxy(uint8Array);
    let fullTextParts = [];

    for (let i = 1; i <= pdf.numPages; i++) {
      const page = await pdf.getPage(i);
      const textContent = await page.getTextContent();
      let pageText = '';
      let prevItem = null;

      for (const item of textContent.items) {
        if (!item || typeof item.str !== 'string') continue;

        if (prevItem) {
          const prevX = prevItem.transform ? prevItem.transform[4] : 0;
          const prevY = prevItem.transform ? prevItem.transform[5] : 0;
          const currentX = item.transform ? item.transform[4] : 0;
          const currentY = item.transform ? item.transform[5] : 0;

          // Check if on same line (y difference is small)
          const sameLine = Math.abs(currentY - prevY) < 5;
          // Check horizontal distance
          const xGap = Math.abs(currentX - prevX);

          // If on new line or horizontal gap is greater than 3 points and neither string starts/ends with space
          if (!sameLine || item.hasEOL) {
            pageText += ' ';
          } else if (xGap > 3 && !prevItem.str.endsWith(' ') && !item.str.startsWith(' ')) {
            pageText += ' ';
          }
        }

        pageText += item.str;
        prevItem = item;
      }

      fullTextParts.push(pageText);
    }

    return fullTextParts.join(' ');
  } catch (err) {
    console.warn('[PDF Position Extract Warning]', err.message);
    return '';
  }
}

/**
 * Combined high-level helper to extract PDF text & count words with fallback
 */
async function getPdfWordCount(fileBuffer) {
  if (!fileBuffer || fileBuffer.length === 0) return 0;
  
  let text = '';
  
  // 1. Try spatial position-aware PDF extraction (fixes Arabic/Urdu RTL spaces)
  try {
    text = await extractPdfTextPositionAware(fileBuffer);
  } catch (e) {
    console.warn('[getPdfWordCount Position Extract Fail]', e.message);
  }

  // 2. Fallback to default unpdf extractText if position-aware failed or returned empty
  if (!text || !text.trim()) {
    try {
      const pdfData = await extractText(new Uint8Array(fileBuffer));
      text = Array.isArray(pdfData.text) ? pdfData.text.join(' ') : (pdfData.text || '');
    } catch (e) {
      console.warn('[getPdfWordCount Default Extract Fail]', e.message);
    }
  }

  // 3. Count words using Unicode regex
  return countWordsAccurately(text);
}

module.exports = {
  countWordsAccurately,
  extractPdfTextPositionAware,
  getPdfWordCount
};
