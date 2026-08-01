const WARNING_INTERVAL_MS = 5 * 60 * 1000;
const warningTimes = new Map();

export function warn(key, message) {
  const now = Date.now();
  const lastWarning = warningTimes.get(key) ?? 0;

  if (now - lastWarning < WARNING_INTERVAL_MS) {
    return;
  };

  warningTimes.set(key, now);
  console.warn(`[widgets] ${message}`);
};

export function resetWarnings() {
  warningTimes.clear();
};
