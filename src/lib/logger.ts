type Level = "info" | "warn" | "error";

// Minimal timestamped logger, scoped per worker so PM2 log lines say who spoke.
export function createLogger(scope: string) {
  const emit = (level: Level, msg: string, meta?: unknown) => {
    const line = `${new Date().toISOString()} [${scope}] ${level.toUpperCase()} ${msg}`;
    const fn = level === "error" ? console.error : level === "warn" ? console.warn : console.log;
    if (meta !== undefined) fn(line, meta);
    else fn(line);
  };
  return {
    info: (msg: string, meta?: unknown) => emit("info", msg, meta),
    warn: (msg: string, meta?: unknown) => emit("warn", msg, meta),
    error: (msg: string, meta?: unknown) => emit("error", msg, meta),
  };
}
