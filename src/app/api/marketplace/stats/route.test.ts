import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('@/lib/backend/config', () => ({
  isFeatureEnabled: vi.fn().mockReturnValue(true),
}));

vi.mock('@/lib/backend/auth', () => ({
  verifySessionToken: vi.fn().mockReturnValue({ valid: false, address: undefined }),
}));

vi.mock('@/lib/backend/rateLimit', () => ({
  checkRateLimit: vi.fn().mockResolvedValue(true),
  getRateLimitWindowSeconds: vi.fn().mockReturnValue(60),
}));

vi.mock('@/lib/backend/cache/factory', () => ({
  cache: {
    get: vi.fn().mockResolvedValue(null),
    set: vi.fn().mockResolvedValue(undefined),
    delete: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock('@/lib/backend/services/marketplace', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/lib/backend/services/marketplace')>();
  return {
    ...original,
    marketplaceService: {
      ...(original.marketplaceService as object),
      getMarketplaceStats: vi.fn().mockResolvedValue({
        activeListings: 5,
        averageYield: 12.5,
        medianPrice: 100,
        typeBreakdown: { Safe: 3, Balanced: 1, Aggressive: 1 },
      }),
    },
  };
});

import { GET } from './route';
import { verifySessionToken } from '@/lib/backend/auth';
import { checkRateLimit } from '@/lib/backend/rateLimit';
import { cache } from '@/lib/backend/cache/factory';
import { isFeatureEnabled } from '@/lib/backend/config';
import { marketplaceService } from '@/lib/backend/services/marketplace';

const mockVerifySessionToken = vi.mocked(verifySessionToken);
const mockCheckRateLimit = vi.mocked(checkRateLimit);
const mockCache = vi.mocked(cache);
const mockIsFeatureEnabled = vi.mocked(isFeatureEnabled);
const mockGetMarketplaceStats = vi.mocked(
  (marketplaceService as { getMarketplaceStats: () => Promise<unknown> }).getMarketplaceStats,
);

const STATS_PAYLOAD = {
  activeListings: 5,
  averageYield: 12.5,
  medianPrice: 100,
  typeBreakdown: { Safe: 3, Balanced: 1, Aggressive: 1 },
};

function makeRequest(authHeader?: string): NextRequest {
  const headers = new Headers({ 'x-forwarded-for': '127.0.0.1' });
  if (authHeader) {
    headers.set('authorization', authHeader);
  }
  const req = new NextRequest('http://localhost:3000/api/marketplace/stats', { headers });
  Object.defineProperty(req, 'ip', { value: '127.0.0.1' });
  return req;
}

const getHandler = GET as (
  req: NextRequest,
  ctx: { params: Record<string, string> },
  correlationId: string,
) => Promise<Response>;

function callGet(req: NextRequest): Promise<Response> {
  return getHandler(req, { params: {} }, 'test-corr-id');
}

describe('GET /api/marketplace/stats', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCheckRateLimit.mockResolvedValue(true);
    mockCache.get.mockResolvedValue(null);
    mockCache.set.mockResolvedValue(undefined);
    mockCache.delete.mockResolvedValue(undefined);
    mockGetMarketplaceStats.mockResolvedValue(STATS_PAYLOAD);
    mockVerifySessionToken.mockReturnValue({ valid: false, address: undefined });
    mockIsFeatureEnabled.mockReturnValue(true);
    mockIsFeatureEnabled.mockReturnValue(true);
  });

  it('returns marketplace stats on success', async () => {
    const res = await callGet(makeRequest());
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.data.activeListings).toBe(5);
    expect(body.data.averageYield).toBe(12.5);
    expect(body.data.medianPrice).toBe(100);
    expect(body.data.typeBreakdown).toEqual({ Safe: 3, Balanced: 1, Aggressive: 1 });
    expect(res.headers.get('X-Cache')).toBe('MISS');
    expect(res.headers.get('X-Cache-Freshness')).toBe('fresh');
  });

  it('serves from cache when available', async () => {
    mockCache.get.mockResolvedValue({
      activeListings: 10,
      averageYield: 8,
      medianPrice: 200,
      typeBreakdown: { Safe: 6, Balanced: 2, Aggressive: 2 },
    });

    const res = await callGet(makeRequest());
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data.activeListings).toBe(10);
    expect(mockGetMarketplaceStats).not.toHaveBeenCalled();
    expect(res.headers.get('X-Cache')).toBe('HIT');
    expect(res.headers.get('X-Cache-Freshness')).toBe('cached');
  });

  it('includes correlationId in the 404 response', async () => {
    mockIsFeatureEnabled.mockImplementation((f: string) => f !== 'marketplace');

    const res = await callGet(makeRequest());
    const body = await res.json();

    expect(res.status).toBe(404);
    expect(body.error.code).toBe('NOT_FOUND');
    expect(res.headers.get('x-correlation-id')).toBeTruthy();
  });

  it('does not invoke rate limit or cache when feature disabled', async () => {
    mockIsFeatureEnabled.mockImplementation((f: string) => f !== 'marketplace');

    await callGet(makeRequest());

    expect(mockCheckRateLimit).not.toHaveBeenCalled();
    expect(mockGetMarketplaceStats).not.toHaveBeenCalled();
  });

  it('invalidates corrupt cache and refetches', async () => {
    mockCache.get.mockResolvedValueOnce({
      activeListings: -1,
      averageYield: 12.5,
      medianPrice: 100,
      typeBreakdown: { Safe: 3, Balanced: 1, Aggressive: 1 },
    });

    const res = await callGet(makeRequest());

    expect(mockCache.delete).toHaveBeenCalled();
    expect(res.status).toBe(200);
    expect(mockGetMarketplaceStats).toHaveBeenCalled();
  });

  it('returns 500 when service returns malformed data', async () => {
    mockGetMarketplaceStats.mockResolvedValueOnce({
      activeListings: 'invalid',
      averageYield: 12.5,
      medianPrice: 100,
      typeBreakdown: { Safe: 3, Balanced: 1, Aggressive: 1 },
    } as unknown);

    const res = await callGet(makeRequest());
    const body = await res.json();

    expect(res.status).toBe(500);
    expect(body.success).toBe(false);
    expect(body.error.code).toBe('INTERNAL_ERROR');
    expect(body.error.message.toLowerCase()).toContain('malformed');
  });

  it('returns 500 when service returns negative values', async () => {
    mockGetMarketplaceStats.mockResolvedValueOnce({
      activeListings: -1,
      averageYield: 12.5,
      medianPrice: 100,
      typeBreakdown: { Safe: 3, Balanced: 1, Aggressive: 1 },
    });

    const res = await callGet(makeRequest());
    const body = await res.json();

    expect(res.status).toBe(500);
    expect(body.success).toBe(false);
    expect(body.error.code).toBe('INTERNAL_ERROR');
  });

  it('returns 500 when typeBreakdown exceeds activeListings', async () => {
    mockGetMarketplaceStats.mockResolvedValueOnce({
      activeListings: 2,
      averageYield: 12.5,
      medianPrice: 100,
      typeBreakdown: { Safe: 3, Balanced: 1, Aggressive: 1 },
    });

    const res = await callGet(makeRequest());
    const body = await res.json();

    expect(res.status).toBe(500);
    expect(body.success).toBe(false);
    expect(body.error.code).toBe('INTERNAL_ERROR');
    expect(body.error.message).toContain('invariant failed');
  });

  it('returns 503 when service throws', async () => {
    mockGetMarketplaceStats.mockRejectedValueOnce(new Error('Chain unavailable'));

    const res = await callGet(makeRequest());
    const body = await res.json();

    expect(res.status).toBe(503);
    expect(body.success).toBe(false);
    expect(body.error.code).toBe('SERVICE_UNAVAILABLE');
  });
});

describe('GET /api/marketplace/stats — rate limiting', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCheckRateLimit.mockResolvedValue(true);
    mockCache.get.mockResolvedValue(null);
    mockCache.set.mockResolvedValue(undefined);
    mockGetMarketplaceStats.mockResolvedValue(STATS_PAYLOAD);
    mockVerifySessionToken.mockReturnValue({ valid: false, address: undefined });
    mockIsFeatureEnabled.mockReturnValue(true);
  });

  it('returns 429 when rate limit is exceeded', async () => {
    mockCheckRateLimit.mockResolvedValue(false);

    const res = await callGet(makeRequest());
    const body = await res.json();

    expect(res.status).toBe(429);
    expect(body.success).toBe(false);
    expect(body.error.code).toBe('TOO_MANY_REQUESTS');
  });

  it('returns retryAfterSeconds in 429 body', async () => {
    mockCheckRateLimit.mockResolvedValue(false);

    const res = await callGet(makeRequest());
    const body = await res.json();

    expect(body.error.retryAfterSeconds).toBe(60);
  });

  it('calls checkRateLimit with the correct routeId', async () => {
    mockCheckRateLimit.mockResolvedValue(false);

    await callGet(makeRequest());

    expect(mockCheckRateLimit).toHaveBeenCalledWith('127.0.0.1', 'api/marketplace/stats');
  });

  it('does not fetch stats when rate limited', async () => {
    mockCheckRateLimit.mockResolvedValue(false);

    await callGet(makeRequest());

    expect(mockGetMarketplaceStats).not.toHaveBeenCalled();
  });
});

describe('GET /api/marketplace/stats — ETag (result cache)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCheckRateLimit.mockResolvedValue(true);
    mockCache.get.mockResolvedValue(null);
    mockCache.set.mockResolvedValue(undefined);
    mockGetMarketplaceStats.mockResolvedValue(STATS_PAYLOAD);
    mockVerifySessionToken.mockReturnValue({ valid: false, address: undefined });
    mockIsFeatureEnabled.mockReturnValue(true);
  });

  it('emits an ETag header', async () => {
    const res = await callGet(makeRequest());
    expect(res.headers.get('ETag')).toBeTruthy();
  });

  it('returns 304 Not Modified when If-None-Match matches generated ETag', async () => {
    const first = await callGet(makeRequest());
    const etag = first.headers.get('ETag');
    expect(etag).toBeTruthy();

    const req = makeRequest();
    req.headers.set('if-none-match', etag!);
    const res = await callGet(req);

    expect(res.status).toBe(304);
    expect(res.headers.get('ETag')).toBe(etag);
    expect(await res.text()).toHaveLength(0);
  });

  it('returns 304 for wildcard If-None-Match', async () => {
    const req = makeRequest();
    req.headers.set('if-none-match', '*');
    const res = await callGet(req);
    expect(res.status).toBe(304);
  });
});

describe('GET /api/marketplace/stats — auth boundary', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCheckRateLimit.mockResolvedValue(true);
    mockCache.get.mockResolvedValue(null);
    mockCache.set.mockResolvedValue(undefined);
    mockGetMarketplaceStats.mockResolvedValue(STATS_PAYLOAD);
  });

  it('allows unauthenticated public access when no auth header is present', async () => {
    mockVerifySessionToken.mockReturnValue({ valid: false, address: undefined });
    const res = await callGet(makeRequest());
    expect(res.status).toBe(200);
  });

  it('allows request with valid session token', async () => {
    mockVerifySessionToken.mockReturnValue({ valid: true, address: 'GADDRESS' });

    const res = await callGet(makeRequest('Bearer session_validtoken_123'));

    expect(res.status).toBe(200);
    expect(mockVerifySessionToken).toHaveBeenCalledWith('session_validtoken_123');
  });

  it('rejects malformed Authorization header', async () => {
    const res = await callGet(makeRequest('InvalidToken'));
    const body = await res.json();

    expect(res.status).toBe(401);
    expect(body.success).toBe(false);
    expect(body.error.code).toBe('UNAUTHORIZED');
  });

  it('rejects invalid bearer token', async () => {
    mockVerifySessionToken.mockReturnValue({ valid: false, address: undefined });

    const res = await callGet(makeRequest('Bearer invalid_token'));
    const body = await res.json();

    expect(res.status).toBe(401);
    expect(body.success).toBe(false);
    expect(body.error.code).toBe('UNAUTHORIZED');
  });
});
