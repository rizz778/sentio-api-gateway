const Redis = require('ioredis');
const crypto = require('crypto');

// Connect to Redis (URL or host/port)
const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379';
const redis = new Redis(redisUrl, {
  maxRetriesPerRequest: 1,
  retryStrategy: (times) => Math.min(times * 100, 3000),
  enableOfflineQueue: false, // Don't block requests if Redis is offline
});

redis.on('connect', () => {
  console.log('[RateLimiter] Connected to Redis successfully');
});

redis.on('error', (err) => {
  console.warn('[RateLimiter] Redis connection issue:', err.message);
});

// Atomic Sliding Window Lua script
const SLIDING_WINDOW_LUA = `
local key = KEYS[1]
local now = tonumber(ARGV[1])
local windowMs = tonumber(ARGV[2])
local maxRequests = tonumber(ARGV[3])
local nonce = ARGV[4]

local windowStart = now - windowMs

-- Remove hits older than the sliding window
redis.call('ZREMRANGEBYSCORE', key, 0, windowStart)

-- Count hits in the current window
local currentCount = redis.call('ZCARD', key)

if currentCount < maxRequests then
    redis.call('ZADD', key, now, now .. ':' .. nonce)
    local ttlSeconds = math.ceil((windowMs / 1000) * 2)
    redis.call('EXPIRE', key, ttlSeconds)
    return {1, currentCount + 1, 0}
else
    local oldest = redis.call('ZRANGE', key, 0, 0, 'WITHSCORES')
    local oldestTime = now
    if oldest and #oldest >= 2 then
        oldestTime = tonumber(oldest[2])
    end
    return {0, currentCount, oldestTime}
end
`;

redis.defineCommand('checkSlidingWindow', {
  numberOfKeys: 1,
  lua: SLIDING_WINDOW_LUA,
});

/**
 * Checks sliding window rate limit in Redis.
 */
async function checkLimit(key, windowMs, maxRequests) {
  const now = Date.now();
  const nonce = crypto.randomBytes(4).toString('hex');

  const result = await redis.checkSlidingWindow(`ratelimit:${key}`, now, windowMs, maxRequests, nonce);

  const allowed = result[0] === 1;
  const count = result[1];
  const oldestTime = result[2] || now;

  if (!allowed) {
    const resetTimeMs = oldestTime + windowMs - now;
    const retryAfter = Math.max(1, Math.ceil(resetTimeMs / 1000));
    return {
      allowed: false,
      limit: maxRequests,
      remaining: 0,
      retryAfterSeconds: retryAfter,
      resetTimestamp: Math.ceil((oldestTime + windowMs) / 1000),
    };
  }

  return {
    allowed: true,
    limit: maxRequests,
    remaining: Math.max(0, maxRequests - count),
    retryAfterSeconds: 0,
    resetTimestamp: Math.ceil((now + windowMs) / 1000),
  };
}

// Limits per minute
const LIMITS = {
  auth: {
    windowMs: 60 * 1000,
    max: parseInt(process.env.RATE_LIMIT_AUTH_MAX || '10', 10),
  },
  'fastapi-backend': {
    windowMs: 60 * 1000,
    max: parseInt(process.env.RATE_LIMIT_FASTAPI_MAX || '25', 10),
  },
  'node-backend': {
    windowMs: 60 * 1000,
    max: parseInt(process.env.RATE_LIMIT_NODE_MAX || '120', 10),
  },
  default: {
    windowMs: 60 * 1000,
    max: parseInt(process.env.RATE_LIMIT_DEFAULT_MAX || '60', 10),
  },
};

/**
 * Auth rate limiter middleware (IP-based).
 */
async function authRateLimiter(req, res, next) {
  const ip = req.ip || req.socket.remoteAddress || 'unknown-ip';
  const key = `auth:${ip}`;

  try {
    const result = await checkLimit(key, LIMITS.auth.windowMs, LIMITS.auth.max);

    res.setHeader('X-RateLimit-Limit', result.limit);
    res.setHeader('X-RateLimit-Remaining', result.remaining);
    res.setHeader('X-RateLimit-Reset', result.resetTimestamp);

    if (!result.allowed) {
      res.setHeader('Retry-After', result.retryAfterSeconds);
      return res.status(429).json({
        error: 'TOO_MANY_REQUESTS',
        message: `Too many authentication attempts. Please retry in ${result.retryAfterSeconds} seconds.`,
        retryAfterSeconds: result.retryAfterSeconds,
      });
    }

    next();
  } catch (err) {
    // Fail-open if Redis error occurs so users are not blocked
    console.warn('[RateLimiter] Error checking auth limit:', err.message);
    next();
  }
}

/**
 * Service rate limiter middleware (User ID / IP + Service).
 */
async function serviceRateLimiter(req, res, next) {
  const service = req.headers['x-sentio-service'] || 'unknown';
  const user = req.user?.uid || req.ip || 'anon';
  const key = `svc:${service}:${user}`;

  const cfg = LIMITS[service] || LIMITS.default;

  try {
    const result = await checkLimit(key, cfg.windowMs, cfg.max);

    res.setHeader('X-RateLimit-Limit', result.limit);
    res.setHeader('X-RateLimit-Remaining', result.remaining);
    res.setHeader('X-RateLimit-Reset', result.resetTimestamp);

    if (!result.allowed) {
      res.setHeader('Retry-After', result.retryAfterSeconds);
      console.warn(`[RateLimiter] Exceeded for ${user} on '${service}'`);
      return res.status(429).json({
        error: 'RATE_LIMIT_EXCEEDED',
        service,
        message: `Rate limit of ${result.limit} req/min exceeded for service '${service}'. Retry in ${result.retryAfterSeconds}s.`,
        retryAfterSeconds: result.retryAfterSeconds,
      });
    }

    next();
  } catch (err) {
    // Fail-open if Redis error occurs
    console.warn('[RateLimiter] Error checking service limit:', err.message);
    next();
  }
}

module.exports = {
  redis,
  authRateLimiter,
  serviceRateLimiter,
};
