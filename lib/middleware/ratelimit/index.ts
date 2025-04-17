import { Context, Next } from "hono";
import { getConnInfo } from "hono/deno";

const RATE_LIMIT = 60; // Max requests per minute one every second.
const RATE_PERIOD = 60 * 1000; // 1 minute in milliseconds
const CLEANUP_INTERVAL = 10 * 60 * 1000; // Clean up the map every 10 minutes

interface RateLimitRecord {
  count: number;
  lastRequest: number;
}

const rateLimitMap = new Map<string, RateLimitRecord>();

// Schedule periodic cleanup to prevent unbounded map growth
const cleanupRateLimitMap = () => {
  const currentTime = Date.now();
  for (const [key, record] of rateLimitMap.entries()) {
    if (currentTime - record.lastRequest > RATE_PERIOD * 2) {
      rateLimitMap.delete(key);
    }
  }
};

// Setup cleanup interval
setInterval(cleanupRateLimitMap, CLEANUP_INTERVAL);

export const middlewareRateLimit = async (c: Context, next: Next) => {
  // Get client identifier with fallbacks for better identification
  const ip = c.req.header("x-forwarded-for") ||
    getConnInfo(c).remote.address ||
    "unknown";

  const userAgent = c.req.header("user-agent") || "unknown-agent";

  // Combine IP and user-agent for more accurate client identification
  const clientId = `${ip}:${userAgent}`;

  const currentTime = Date.now();
  const record = rateLimitMap.get(clientId) ||
    { count: 0, lastRequest: currentTime };

  if (currentTime - record.lastRequest > RATE_PERIOD) {
    record.count = 1;
    record.lastRequest = currentTime;
  } else {
    record.count += 1;
  }

  rateLimitMap.set(clientId, record);

  if (record.count > RATE_LIMIT) {
    return c.text("Too Many Requests", 429);
  }

  await next();
};
