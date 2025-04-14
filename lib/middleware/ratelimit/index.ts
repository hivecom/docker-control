import { Context, Next } from "hono";
import { getConnInfo } from "hono/deno";

const RATE_LIMIT = 12; // Max requests per minute (One every 5 seconds)
const RATE_PERIOD = 60 * 1000; // 1 minute in milliseconds

const rateLimitMap = new Map<string, { count: number; lastRequest: number }>();

export const middlewareRateLimit = async (c: Context, next: Next) => {
  const ip =
    c.req.header("x-forwarded-for") ||
    getConnInfo(c).remote.address ||
    "unknown";

  const currentTime = Date.now();
  const record = rateLimitMap.get(ip) || { count: 0, lastRequest: currentTime };

  if (currentTime - record.lastRequest > RATE_PERIOD) {
    record.count = 1;
    record.lastRequest = currentTime;
  } else {
    record.count += 1;
  }

  rateLimitMap.set(ip, record);

  if (record.count > RATE_LIMIT) {
    return c.text("Too Many Requests", 429);
  }

  await next();
};
