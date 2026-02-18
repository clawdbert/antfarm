/** Default cron polling interval (ms). */
export const DEFAULT_EVERY_MS = 300_000; // 5 minutes

/** Default agent session timeout (seconds). */
export const DEFAULT_AGENT_TIMEOUT_SECONDS = 45 * 60; // 45 minutes

/** Default margin added beyond agent timeout before marking a step abandoned (ms). */
export const DEFAULT_ABANDONED_MARGIN_MS = 300_000; // 5 minutes

/** Max times a run can be auto-resumed before requiring human intervention. */
export const MAX_AUTO_RESUMES = 3;
