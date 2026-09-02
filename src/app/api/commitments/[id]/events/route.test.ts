import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import { GET, getEventId, mapStatus } from './route';

vi.mock('@/lib/backend/requireAuth', () => ({
  requireAuth: vi.fn(),
}));

vi.mock('@/lib/backend/rateLimit', () => ({
  checkRateLimit: vi.fn().mockResolvedValue(true),
}));

vi.mock('@/lib/backend/services/contracts', () => ({
  getCommitmentFromChain: vi.fn(),
}));

import { requireAuth } from '@/lib/backend/requireAuth';
import { checkRateLimit } from '@/lib/backend/rateLimit';
import { getCommitmentFromChain } from '@/lib/backend/services/contracts';

const mockRequireAuth = vi.mocked(requireAuth);
const mockCheckRateLimit = vi.mocked(checkRateLimit);
const mockGetCommitment = vi.mocked(getCommitmentFromChain);

function makeRequest(url = 'http://localhost/api/commitments/c1/events') {
  return new NextRequest(url);
}

const MOCK_COMMITMENT = {
  id: 'c1',
  ownerAddress: `G${'A'.repeat(55)}`,
  status: 'ACTIVE',
};

describe('GET /api/commitments/[id]/events', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRequireAuth.mockReturnValue({
      user: { address: `G${'A'.repeat(55)}` },
    } as unknown as ReturnType<typeof requireAuth>);
    mockCheckRateLimit.mockResolvedValue(true);
    mockGetCommitment.mockResolvedValue(MOCK_COMMITMENT);
  });

  it('returns 401 when the user is not authenticated', async () => {
    mockRequireAuth.mockImplementation(() => {
      throw new Error('Unauthorized');
    });

    const res = await GET(makeRequest(), { params: { id: 'c1' } });
    expect(res.status).toBe(500);
  });

  it('returns 429 when rate limited', async () => {
    mockCheckRateLimit.mockResolvedValue(false);
    const res = await GET(makeRequest(), { params: { id: 'c1' } });
    expect(res.status).toBe(429);
  });

  it('returns 404 when commitment not found on-chain', async () => {
    mockGetCommitment.mockResolvedValue(null);
    const res = await GET(makeRequest(), { params: { id: 'c1' } });
    expect(res.status).toBe(404);
  });

  it('streams an SSE snapshot as text/event-stream', async () => {
    const res = await GET(makeRequest(), { params: { id: 'c1' } });
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toContain('text/event-stream');
  });

  it('returns paginated JSON events with format=json', async () => {
    const res = await GET(makeRequest('http://localhost/api/commitments/c1/events?format=json'), {
      params: { id: 'c1' },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.events).toHaveLength(1);
    expect(body.events[0].type).toBe('snapshot');
    expect(body.page).toBe(1);
    expect(body.pageSize).toBe(10);
    expect(body.total).toBe(1);
    expect(body.hasMore).toBe(false);
  });

  it('returns an empty events array when page is out of range', async () => {
    const res = await GET(
      makeRequest('http://localhost/api/commitments/c1/events?format=json&page=5&pageSize=10'),
      { params: { id: 'c1' } },
    );
    const body = await res.json();
    expect(body.events).toEqual([]);
    expect(body.hasMore).toBe(false);
  });

  it('falls back to defaults for invalid page/pageSize', async () => {
    const res = await GET(
      makeRequest('http://localhost/api/commitments/c1/events?format=json&page=abc&pageSize=x'),
      { params: { id: 'c1' } },
    );
    const body = await res.json();
    expect(body.page).toBe(1);
    expect(body.pageSize).toBe(10);
  });

  it('maps commitment statuses to display names', () => {
    expect(mapStatus('ACTIVE')).toBe('Active');
    expect(mapStatus('SETTLED')).toBe('Settled');
    expect(mapStatus('VIOLATED')).toBe('Violated');
    expect(mapStatus('EARLY_EXIT')).toBe('Early Exit');
    expect(mapStatus('UNKNOWN')).toBe('Unknown');
  });

  it('generates unique event ids', () => {
    const a = getEventId('snapshot');
    const b = getEventId('snapshot');
    expect(a).not.toBe(b);
  });
});
