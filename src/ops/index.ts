/**
 * Operational helpers — minimal v0.1.0 surface.
 *
 * v0.2 will fold in the cache-debug / cache-flush endpoint helpers from the
 * reference implementation (next-redis-cache-demo/app/api/cache-{debug,flush}).
 * For now, just expose the metrics snapshot so consumers can wire up
 * `/api/cache-stats` if they want.
 */

export { getMetricSnapshot } from "../shared/metrics.js";
