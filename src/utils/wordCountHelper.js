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
 * Converts raw RGBA/RGB pixel buffer into a 32-bit BMP Buffer for Tesseract OCR ingestion
 */
function rgbaToBmpBuffer(rgbaBuffer, width, height) {
  const rowSize = width * 4;
  const pixelArraySize = rowSize * height;
  const fileSize = 54 + pixelArraySize;

  const buf = Buffer.alloc(fileSize);

  // File Header
  buf.write('BM', 0);
  buf.writeUInt32LE(fileSize, 2);
  buf.writeUInt32LE(54, 10); // Offset to pixel array

  // DIB Header (BITMAPINFOHEADER)
  buf.writeUInt32LE(40, 14); // Header size
  buf.writeInt32LE(width, 18);
  buf.writeInt32LE(-height, 22); // Top-down
  buf.writeUInt16LE(1, 26); // Planes
  buf.writeUInt16LE(32, 28); // 32 bits per pixel (RGBA)
  buf.writeUInt32LE(0, 30); // Compression (BI_RGB)
  buf.writeUInt32LE(pixelArraySize, 34);

  let srcIdx = 0;
  for (let y = 0; y < height; y++) {
    const rowOffset = 54 + y * rowSize;
    for (let x = 0; x < width; x++) {
      const r = rgbaBuffer[srcIdx];
      const g = rgbaBuffer[srcIdx + 1];
      const b = rgbaBuffer[srcIdx + 2];
      const a = rgbaBuffer[srcIdx + 3];

      const dstIdx = rowOffset + x * 4;
      buf[dstIdx] = b;     // Blue
      buf[dstIdx + 1] = g; // Green
      buf[dstIdx + 2] = r; // Red
      buf[dstIdx + 3] = a; // Alpha

      srcIdx += 4;
    }
  }

  return buf;
}

/**
 * Extracts raw image buffers from Scanned / Image PDFs
 */
async function extractImagesFromPdf(fileBuffer) {
  try {
    const uint8Array = new Uint8Array(fileBuffer);
    const pdf = await getDocumentProxy(uint8Array);
    const imageBuffers = [];

    for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
      const page = await pdf.getPage(pageNum);
      const operatorList = await page.getOperatorList();

      for (let i = 0; i < operatorList.fnArray.length; i++) {
        const args = operatorList.argsArray[i];

        if (args && args[0] && typeof args[0] === 'string' && args[0].startsWith('img_')) {
          const imgName = args[0];
          try {
            const imgObj = await new Promise((resolve) => {
              if (page.objs.has(imgName)) {
                resolve(page.objs.get(imgName));
              } else {
                page.objs.get(imgName, (img) => resolve(img));
              }
            });

            if (imgObj && imgObj.data && imgObj.width && imgObj.height) {
              const { width, height, data } = imgObj;
              let bmpBuf = null;

              if (data.length === width * height * 4) { // RGBA
                bmpBuf = rgbaToBmpBuffer(data, width, height);
              } else if (data.length === width * height * 3) { // RGB
                const rgba = new Uint8Array(width * height * 4);
                let s = 0, d = 0;
                while (s < data.length) {
                  rgba[d] = data[s];
                  rgba[d + 1] = data[s + 1];
                  rgba[d + 2] = data[s + 2];
                  rgba[d + 3] = 255;
                  s += 3;
                  d += 4;
                }
                bmpBuf = rgbaToBmpBuffer(rgba, width, height);
              }

              if (bmpBuf) {
                imageBuffers.push(bmpBuf);
              }
            }
          } catch (e) {
            console.warn('[PDF Image Extract Warn]', e.message);
          }
        }
      }
    }

    return imageBuffers;
  } catch (err) {
    console.warn('[extractImagesFromPdf Err]', err.message);
    return [];
  }
}

/**
 * Tesseract OCR Engine Fallback for Scanned / Image PDFs
 */
async function performOcrOnPdfImages(fileBuffer, languageHint = 'English') {
  let worker = null;
  try {
    const images = await extractImagesFromPdf(fileBuffer);
    if (!images || images.length === 0) return 0;

    // Pick Tesseract language models based on document language hint
    let langs = 'eng+ara+urd+spa';
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
 * Tier 2: Automatic OCR Engine fallback for scanned/image PDFs returning 0 words
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
  // automatically trigger Tesseract OCR Engine to scan image pixels!
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
  performOcrOnPdfImages,
  getPdfWordCount
};
