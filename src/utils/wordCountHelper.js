const { getDocumentProxy, extractText } = require('unpdf');
const { createWorker } = require('tesseract.js');

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
 * Pure Node.js Binary Stream Extractor: Extracts raw JPEG and PNG image buffers directly
 * from PDF binary streams without DOM Canvas or OS dependencies.
 */
function extractRawImagesFromPdfBuffer(pdfBuffer) {
  const images = [];
  if (!pdfBuffer || pdfBuffer.length === 0) return images;

  const buf = Buffer.isBuffer(pdfBuffer) ? pdfBuffer : Buffer.from(pdfBuffer);
  
  // 1. Scan for JPEG images (Starts with 0xFF 0xD8 0xFF, Ends with 0xFF 0xD9)
  let pos = 0;
  while (pos < buf.length - 3) {
    if (buf[pos] === 0xFF && buf[pos + 1] === 0xD8 && buf[pos + 2] === 0xFF) {
      const start = pos;
      let end = start + 3;
      while (end < buf.length - 1) {
        if (buf[end] === 0xFF && buf[end + 1] === 0xD9) {
          end += 2;
          break;
        }
        end++;
      }
      if (end > start + 100) { // Valid JPEG size > 100 bytes
        const jpegBuf = buf.subarray(start, end);
        images.push(jpegBuf);
        pos = end;
        continue;
      }
    }
    pos++;
  }

  // 2. Scan for PNG images (Starts with 0x89 0x50 0x4E 0x47 0x0D 0x0A 0x1A 0x0A)
  pos = 0;
  while (pos < buf.length - 8) {
    if (
      buf[pos] === 0x89 &&
      buf[pos + 1] === 0x50 &&
      buf[pos + 2] === 0x4E &&
      buf[pos + 3] === 0x47 &&
      buf[pos + 4] === 0x0D &&
      buf[pos + 5] === 0x0A &&
      buf[pos + 6] === 0x1A &&
      buf[pos + 7] === 0x0A
    ) {
      const start = pos;
      let end = start + 8;
      while (end < buf.length - 8) {
        if (
          buf[end] === 0x49 &&
          buf[end + 1] === 0x45 &&
          buf[end + 2] === 0x4E &&
          buf[end + 3] === 0x44
        ) {
          end += 8;
          break;
        }
        end++;
      }
      if (end > start + 100) {
        const pngBuf = buf.subarray(start, end);
        images.push(pngBuf);
        pos = end;
        continue;
      }
    }
    pos++;
  }

  return images;
}

/**
 * Tesseract OCR Engine Fallback for Scanned / Image PDFs
 */
async function performOcrOnPdfImages(fileBuffer, languageHint = 'English') {
  let worker = null;
  try {
    const images = extractRawImagesFromPdfBuffer(fileBuffer);
    if (!images || images.length === 0) return 0;

    // Pick Tesseract language models based on document language hint
    let langs = 'ara+urd+spa+eng';
    const lowerLang = (languageHint || '').toLowerCase();
    if (lowerLang.includes('arabic')) langs = 'ara+eng';
    else if (lowerLang.includes('urdu')) langs = 'urd+ara+eng';
    else if (lowerLang.includes('spanish')) langs = 'spa+eng';

    worker = await createWorker(langs);
    let totalOcrWords = 0;

    for (const imgBuf of images) {
      const { data } = await worker.recognize(imgBuf);
      if (data && data.text) {
        totalOcrWords += countWordsAccurately(data.text);
      }
    }

    return totalOcrWords;
  } catch (err) {
    console.warn('[Tesseract OCR Fallback Warn]', err.message);
    return 0;
  } finally {
    if (worker) {
      try { await worker.terminate(); } catch (e) {}
    }
  }
}

/**
 * Combined Tier-1 & Tier-2 Hybrid PDF Word Counter:
 * Tier 1: Fast position-aware digital text extraction
 * Tier 2: Pure Binary Stream + Tesseract OCR Engine fallback for scanned/image PDFs returning 0 words
 */
async function getPdfWordCount(fileBuffer, languageHint = 'English') {
  if (!fileBuffer || fileBuffer.length === 0) return 0;
  
  let text = '';
  
  // Tier 1: Try spatial position-aware PDF text extraction
  try {
    text = await extractPdfTextPositionAware(fileBuffer);
  } catch (e) {
    console.warn('[getPdfWordCount Position Extract Fail]', e.message);
  }

  // Fallback to default unpdf extractText if position-aware returned empty
  if (!text || !text.trim()) {
    try {
      const pdfData = await extractText(new Uint8Array(fileBuffer));
      text = Array.isArray(pdfData.text) ? pdfData.text.join(' ') : (pdfData.text || '');
    } catch (e) {
      console.warn('[getPdfWordCount Default Extract Fail]', e.message);
    }
  }

  let wordCount = countWordsAccurately(text);

  // Tier 2: If Tier 1 digital text extraction yields 0 words (Scanned Photo / Image PDF),
  // automatically trigger Pure Binary Stream + Tesseract OCR Engine to scan image pixels!
  if (wordCount === 0) {
    try {
      wordCount = await performOcrOnPdfImages(fileBuffer, languageHint);
    } catch (ocrErr) {
      console.warn('[getPdfWordCount Tier-2 OCR Fail]', ocrErr.message);
    }
  }

  return wordCount;
}

module.exports = {
  countWordsAccurately,
  extractPdfTextPositionAware,
  extractRawImagesFromPdfBuffer,
  performOcrOnPdfImages,
  getPdfWordCount
};
