export function median(values) {
  const sorted = [...values].sort();
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
}

export function mean(values) {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}
