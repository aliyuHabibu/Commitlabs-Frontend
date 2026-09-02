/**
 * Route-level tests for POST /api/marketplace/listings/[id]/purchase
 *
 * Covers: success, feature gate, auth, rate limit, wallet-match, body
 * validation, idempotency (replay / in-progress / conflict), malformed id,
 * and service errors (not-found / conflict).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMockRequest, createMockRouteContext, parseResponse } from './helpers';

vi.mock('@/lib/backend/config', () => ({
  isFeatureEnabled: vi.fn(() => true),
}));

vi.mock('@/lib/backend/csrf', () => ({
  assertMutationCsrf: vi.fn(),
}));

vi.mock('@/lib/backend/requireAuth', () => ({
  verifyAuth: vi.fn(),
}));

vi.mock('@/lib/backend/rateLimit', () => ({
  checkRateLimit: vi.fn(),
}));

vi.mock('@/lib/backend/idempotency', () => ({
  idempotencyService: {
    getRecord: vi.fn(),
    start: vi.fn(),
    complete: vi.fn(),
    fail: vi.fn(),
  },
}));

vi.mock('@/lib/backend/services/marketplace', () => ({
  marketplaceService: {
    completePurchase: vi.fn(),
  },
}));

vi.mock('@/lib/backend/services/contracts', () => ({
  transferOwnership: vi.fn(),
}));

vi.mock('@/lib/backend/auditLog', () => ({
  appendAuditEvent: vi.fn(),
}));

vi.mock('@/lib/backend/logger', () => ({
  logInfo: vi.fn(),
  logError: vi.fn(),
  logWarn: vi.fn(),
}));

vi.mock('@stellar/stellar-sdk', () => ({
  default: {
    StrKey: {
      isValidEd25519PublicKey: (address: string) => /^G[A-Z2-7]{55}$/.test(address),
    },
  },
}));

// ─── Imports (after mocks) ────────────────────────────────────────────────────

import { POST } from '@/app/api/marketplace/listings/[id]/purchase/route';
import { verifyAuth } from '@/lib/backend/requireAuth';
import { checkRateLimit } from '@/lib/backend/rateLimit';
import { isFeatureEnabled } from '@/lib/backend/config';
import { idempotencyService } from '@/lib/backend/idempotency';
import { marketplaceService } from '@/lib/backend/services/marketplace';
import { transferOwnership } from '@/lib/backend/services/contracts';
import { appendAuditEvent } from '@/lib/backend/auditLog';
import { ConflictError, NotFoundError, UnauthorizedError } from '@/lib/backend/errors';

const mockedVerifyAuth = vi.mocked(verifyAuth);
const mockedCheckRateLimit = vi.mocked(checkRateLimit);
const mockedIsFeatureEnabled = vi.mocked(isFeatureEnabled);
const mockedIdempotencyGetRecord = vi.mocked(idempotencyService.getRecord);
const mockedIdempotencyStart = vi.mocked(idempotencyService.start);
const mockedCompletePurchase = vi.mocked(marketplaceService.completePurchase);

const BUYER = `G${'B'.repeat(55)}`;
const SELLER = `G${'A'.repeat(55)}`;
const NETWORK_PASSPHRASE = 'Test SDF Network ; September 2015';

const mockPOST = POST as (
  req: ReturnType<typeof createMockRequest>,
  context: { params: Record<string, string> },
) => Promise<Response>;

const purchasedListing = {
  id: 'listing_1_123',
  commitmentId: 'cm_abc',
  price: '52000',
  currencyAsset: 'USDC',
  sellerAddress: SELLER,
  status: 'Sold' as const,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-02T00:00:00.000Z',
};

const TRANSFER_RESULT = {
  commitmentId: 'cm_abc',
  fromAddress: SELLER,
  toAddress: BUYER,
  txHash: '0xabc123',
  reference: 'ref-001',
};

function purchaseRequest(
  listingId: string,
  body: Record<string, unknown> = { buyerAddress: BUYER, networkPassphrase: NETWORK_PASSPHRASE },
  headers: Record<string, string> = {},
) {
  return [
    createMockRequest(`http://localhost:3000/api/marketplace/listings/${listingId}/purchase`, {
      method: 'POST',
      body,
      headers,
    }),
    createMockRouteContext({ id: listingId }),
  ] as const;
}

describe('POST /api/marketplace/listings/[id]/purchase', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedIsFeatureEnabled.mockReturnValue(true);
    mockedVerifyAuth.mockReturnValue({ address: BUYER, isAdmin: false } as never);
    mockedCheckRateLimit.mockResolvedValue(true);
    mockedIdempotencyGetRecord.mockResolvedValue(null);
    mockedIdempotencyStart.mockResolvedValue(true);
    mockedCompletePurchase.mockResolvedValue(purchasedListing as never);
    vi.mocked(transferOwnership).mockResolvedValue(TRANSFER_RESULT as never);
    vi.mocked(appendAuditEvent).mockResolvedValue(undefined);
  });

  it('returns 200 with purchase details on success', async () => {
    const [req, ctx] = purchaseRequest('listing_1_123');
    const response = await mockPOST(req, ctx);
    const { status, data } = await parseResponse(response);

    expect(status).toBe(200);
    expect(data.success).toBe(true);
    expect(data.data.listingId).toBe('listing_1_123');
    expect(data.data.commitmentId).toBe('cm_abc');
    expect(data.data.buyerAddress).toBe(BUYER);
    expect(data.data.sellerAddress).toBe(SELLER);
    expect(data.data.txHash).toBe('0xabc123');
    expect(data.data.purchasedAt).toBe('2026-01-02T00:00:00.000Z');

    expect(mockedCompletePurchase).toHaveBeenCalledWith('listing_1_123', BUYER);
    expect(transferOwnership).toHaveBeenCalledWith({
      commitmentId: 'cm_abc',
      fromAddress: SELLER,
      toAddress: BUYER,
    });
    expect(appendAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'marketplace.purchase' }),
    );
  });

  it('coerces missing txHash to null', async () => {
    vi.mocked(transferOwnership).mockResolvedValue({
      ...TRANSFER_RESULT,
      txHash: undefined,
    } as never);
    const [req, ctx] = purchaseRequest('listing_1_123');
    const { data } = await parseResponse(await mockPOST(req, ctx));

    expect(data.data.txHash).toBeNull();
  });

  it('rejects when the marketplace feature is disabled', async () => {
    mockedIsFeatureEnabled.mockReturnValue(false);
    const [req, ctx] = purchaseRequest('listing_1_123');
    const { status, data } = await parseResponse(await mockPOST(req, ctx));

    expect(status).toBe(404);
    expect(data.error.code).toBe('NOT_FOUND');
    expect(mockedCompletePurchase).not.toHaveBeenCalled();
  });

  it('returns 401 when the caller is unauthenticated', async () => {
    mockedVerifyAuth.mockImplementation(() => {
      throw new UnauthorizedError('Bearer token required');
    });
    const [req, ctx] = purchaseRequest('listing_1_123');
    const { status, data } = await parseResponse(await mockPOST(req, ctx));

    expect(status).toBe(401);
    expect(data.error.code).toBe('UNAUTHORIZED');
  });

  it('returns 429 when the rate limit is exceeded', async () => {
    mockedCheckRateLimit.mockResolvedValue(false);
    const [req, ctx] = purchaseRequest('listing_1_123');
    const { status, data } = await parseResponse(await mockPOST(req, ctx));

    expect(status).toBe(429);
    expect(data.error.code).toBe('TOO_MANY_REQUESTS');
    expect(mockedCompletePurchase).not.toHaveBeenCalled();
  });

  it('returns 403 when buyerAddress does not match the session', async () => {
    const [req, ctx] = purchaseRequest('listing_1_123', {
      buyerAddress: SELLER,
      networkPassphrase: NETWORK_PASSPHRASE,
    });
    const { status, data } = await parseResponse(await mockPOST(req, ctx));

    expect(status).toBe(403);
    expect(data.error.code).toBe('FORBIDDEN');
    expect(mockedCompletePurchase).not.toHaveBeenCalled();
  });

  it('rejects a missing buyerAddress (400)', async () => {
    const [req, ctx] = purchaseRequest('listing_1_123', {
      networkPassphrase: NETWORK_PASSPHRASE,
    });
    const { status, data } = await parseResponse(await mockPOST(req, ctx));

    expect(status).toBe(400);
    expect(data.error.code).toBe('VALIDATION_ERROR');
  });

  it('rejects an invalid Stellar address (400)', async () => {
    const [req, ctx] = purchaseRequest('listing_1_123', {
      buyerAddress: 'not-a-wallet',
      networkPassphrase: NETWORK_PASSPHRASE,
    });
    const { status } = await parseResponse(await mockPOST(req, ctx));

    expect(status).toBe(400);
  });

  it('rejects an unsupported network passphrase (400)', async () => {
    const [req, ctx] = purchaseRequest('listing_1_123', {
      buyerAddress: BUYER,
      networkPassphrase: 'Different Network ; 2026',
    });
    const { status, data } = await parseResponse(await mockPOST(req, ctx));

    expect(status).toBe(400);
    expect(data.error.code).toBe('VALIDATION_ERROR');
  });

  it('rejects a malformed listing id before the service lookup (400)', async () => {
    const [req, ctx] = purchaseRequest('../listing_1_123');
    const { status } = await parseResponse(await mockPOST(req, ctx));

    expect(status).toBe(400);
    expect(mockedCompletePurchase).not.toHaveBeenCalled();
  });

  it('propagates a NotFoundError from completePurchase (404)', async () => {
    mockedCompletePurchase.mockRejectedValue(new NotFoundError('Listing', { listingId: 'x' }));
    const [req, ctx] = purchaseRequest('missing_listing');
    const { status, data } = await parseResponse(await mockPOST(req, ctx));

    expect(status).toBe(404);
    expect(data.error.code).toBe('NOT_FOUND');
  });

  it('propagates a ConflictError from completePurchase (409)', async () => {
    mockedCompletePurchase.mockRejectedValue(
      new ConflictError('Only active listings can be purchased.'),
    );
    const [req, ctx] = purchaseRequest('listing_1_123');
    const { status, data } = await parseResponse(await mockPOST(req, ctx));

    expect(status).toBe(409);
    expect(data.error.code).toBe('CONFLICT');
  });

  it('replays a completed idempotent purchase', async () => {
    mockedIdempotencyGetRecord.mockResolvedValue({
      key: 'purchase-key',
      status: 'COMPLETED',
      response: {
        data: {
          listingId: 'listing_1_123',
          commitmentId: 'cm_abc',
          buyerAddress: BUYER,
          sellerAddress: SELLER,
          txHash: '0xcached',
          purchasedAt: '2026-01-02T00:00:00.000Z',
        },
      },
      statusCode: 200,
      createdAt: Date.now(),
      expiresAt: Date.now() + 86400000,
    });

    const [req, ctx] = purchaseRequest('listing_1_123', undefined, {
      'idempotency-key': 'purchase-key',
    });
    const { status, data } = await parseResponse(await mockPOST(req, ctx));

    expect(status).toBe(200);
    expect(data.data.data.txHash).toBe('0xcached');
    expect(transferOwnership).not.toHaveBeenCalled();
    expect(mockedCompletePurchase).not.toHaveBeenCalled();
  });

  it('returns 429 when the idempotency key is already in progress', async () => {
    mockedIdempotencyGetRecord.mockResolvedValue({
      key: 'purchase-key',
      status: 'STARTED',
      createdAt: Date.now(),
      expiresAt: Date.now() + 86400000,
    });

    const [req, ctx] = purchaseRequest('listing_1_123', undefined, {
      'idempotency-key': 'purchase-key',
    });
    const { status, data } = await parseResponse(await mockPOST(req, ctx));

    expect(status).toBe(429);
    expect(data.error.code).toBe('TOO_MANY_REQUESTS');
  });

  it('returns 409 when idempotency start loses the race', async () => {
    mockedIdempotencyStart.mockResolvedValue(false);
    const [req, ctx] = purchaseRequest('listing_1_123', undefined, {
      'idempotency-key': 'purchase-key',
    });
    const { status, data } = await parseResponse(await mockPOST(req, ctx));

    expect(status).toBe(409);
    expect(data.error.code).toBe('CONFLICT');
  });

  it('rejects an over-long idempotency key (400)', async () => {
    const [req, ctx] = purchaseRequest('listing_1_123', undefined, {
      'idempotency-key': 'k'.repeat(200),
    });
    const { status } = await parseResponse(await mockPOST(req, ctx));

    expect(status).toBe(400);
  });
});
