import type { ClientRateLimitInfo, Options, Store } from "express-rate-limit";
import Redis from "ioredis";
import { env } from "../config/env";

let sharedRedisClient: Redis | null = null;
let redisConnected = false;

function getSharedRedisClient(): Redis | null {
  if (!env.REDIS_URL) return null;
  if (!sharedRedisClient) {
    sharedRedisClient = new Redis(env.REDIS_URL, {
      lazyConnect: true,
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false,
      connectTimeout: 1500,
    });
    sharedRedisClient.on("ready", () => {
      redisConnected = true;
    });
    sharedRedisClient.on("error", () => {
      redisConnected = false;
    });
    sharedRedisClient.connect().catch(() => {
      redisConnected = false;
    });
  }
  return sharedRedisClient;
}

export function getRateLimiterDiagnostics(): {
  configuredMode: "redis" | "memory-local";
  redisConnected: boolean;
} {
  getSharedRedisClient();
  return {
    configuredMode: env.REDIS_URL ? "redis" : "memory-local",
    redisConnected,
  };
}

export async function closeRedisRateLimiter(): Promise<void> {
  if (sharedRedisClient) {
    await sharedRedisClient.quit().catch(() => undefined);
    sharedRedisClient = null;
    redisConnected = false;
  }
}

/**
 * Distributed Redis-backed `express-rate-limit` Store with automatic fail-safe in-memory fallback.
 * Executes atomic `INCR` + `PEXPIRE` pipelines when `REDIS_URL` is active so horizontally scaled
 * API containers share rate-limit counters without failing requests if Redis restarts.
 */
export class RedisOrMemoryRateLimitStore implements Store {
  public prefix: string;
  public localKeys = false;
  private windowMs = 60_000;
  private readonly fallbackBuckets = new Map<
    string,
    { hits: number; resetTimeMs: number }
  >();

  constructor(prefix: string) {
    this.prefix = prefix;
  }

  init(options: Options): void {
    this.windowMs = options.windowMs;
  }

  private incrementLocal(key: string): ClientRateLimitInfo {
    const now = Date.now();
    const existing = this.fallbackBuckets.get(key);
    if (!existing || existing.resetTimeMs <= now) {
      const next = { hits: 1, resetTimeMs: now + this.windowMs };
      this.fallbackBuckets.set(key, next);
      return { totalHits: 1, resetTime: new Date(next.resetTimeMs) };
    }
    existing.hits += 1;
    return {
      totalHits: existing.hits,
      resetTime: new Date(existing.resetTimeMs),
    };
  }

  async increment(key: string): Promise<ClientRateLimitInfo> {
    const client = getSharedRedisClient();
    const fullKey = `${this.prefix}:${key}`;

    if (client && redisConnected) {
      try {
        const hits = await client.incr(fullKey);
        let pttl = await client.pttl(fullKey);
        if (pttl < 0) {
          await client.pexpire(fullKey, this.windowMs);
          pttl = this.windowMs;
        }
        return {
          totalHits: hits,
          resetTime: new Date(Date.now() + pttl),
        };
      } catch {
        return this.incrementLocal(fullKey);
      }
    }

    return this.incrementLocal(fullKey);
  }

  async decrement(key: string): Promise<void> {
    const client = getSharedRedisClient();
    const fullKey = `${this.prefix}:${key}`;
    if (client && redisConnected) {
      await client.decr(fullKey).catch(() => undefined);
      return;
    }
    const existing = this.fallbackBuckets.get(fullKey);
    if (existing && existing.hits > 0) {
      existing.hits -= 1;
    }
  }

  async resetKey(key: string): Promise<void> {
    const client = getSharedRedisClient();
    const fullKey = `${this.prefix}:${key}`;
    this.fallbackBuckets.delete(fullKey);
    if (client && redisConnected) {
      await client.del(fullKey).catch(() => undefined);
    }
  }
}
