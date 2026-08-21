/**
 * Computes the Levenshtein distance between two strings.
 */
function getLevenshteinDistance(s1, s2) {
  const m = s1.length;
  const n = s2.length;
  const dp = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0));

  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = s1[i - 1] === s2[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,      // deletion
        dp[i][j - 1] + 1,      // insertion
        dp[i - 1][j - 1] + cost // substitution
      );
    }
  }
  return dp[m][n];
}

/**
 * Calculates string similarity ratio between 0 and 1.
 */
function calculateSimilarity(str1, str2) {
  const len1 = str1.length;
  const len2 = str2.length;
  if (len1 === 0 && len2 === 0) return 1.0;
  if (len1 === 0 || len2 === 0) return 0.0;

  const distance = getLevenshteinDistance(str1, str2);
  const maxLength = Math.max(len1, len2);
  return (maxLength - distance) / maxLength;
}

/**
 * Compares two name strings using fuzzy logic.
 * Returns true if similarity exceeds threshold (default 85%).
 */
exports.isNameSimilar = (name1, name2, threshold = 0.85) => {
  const norm1 = (name1 || '').toLowerCase().replace(/[^a-z0-9]/g, ' ').replace(/\s+/g, ' ').trim();
  const norm2 = (name2 || '').toLowerCase().replace(/[^a-z0-9]/g, ' ').replace(/\s+/g, ' ').trim();

  if (!norm1 || !norm2) return false;
  if (norm1 === norm2) return true;

  // Check direct overlap or Levenshtein similarity
  const sim = calculateSimilarity(norm1, norm2);
  if (sim >= threshold) return true;

  // Split into tokens (first, last name comparison)
  const tokens1 = norm1.split(' ');
  const tokens2 = norm2.split(' ');
  
  if (tokens1.length >= 2 && tokens2.length >= 2) {
    // If exact match of first and last name regardless of middle names
    const firstMatch = tokens1[0] === tokens2[0];
    const lastMatch = tokens1[tokens1.length - 1] === tokens2[tokens2.length - 1];
    if (firstMatch && lastMatch) return true;
  }

  return false;
};
