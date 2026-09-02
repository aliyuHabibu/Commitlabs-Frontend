import { NextRequest, NextResponse } from 'next/server';
import { ok, methodNotAllowed } from '@/lib/backend/apiResponse';
import { isFeatureEnabled } from '@/lib/backend/config';
import { assertMutationCsrf } from '@/lib/backend/csrf';
import { createCorsOptionsHandler, type CorsRoutePolicy } from '@/lib/backend/cors';
import { ConflictError, TooManyRequestsError, ValidationError } from '@/lib/backend/errors';
import { getClientIp } from '@/lib/backend/getClientIp';
import { idempotencyService } from '@/lib/backend/idempotency';
import { parseJsonWithLimit, JSON_BODY_LIMITS } from '@/lib/backend/jsonBodyLimit';
import { checkRateLimit } from '@/lib/backend/rateLimit';
import { verifyAuth } from '@/lib/backend/requireAuth';
import {
  getMarketplaceSortKeys,
  isMarketplaceSortBy,
  listMarketplaceListings,
  marketplaceService,
  type MarketplaceCommitmentType,
  type MarketplacePublicListing,
} from '@/lib/backend/services/marketplace';
import {
  assertWalletMatchesSession,
  MarketplaceCreateListingBoundarySchema,
} from '@/lib/backend/marketplaceBoundary';
import { withApiHandler } from '@/lib/backend/withApiHandler';
import { MAX_PAGE_SIZE } from '@/lib/backend/pagination';
import type { CreateListingRequest, CreateListingResponse } from '@/types/marketplace';
import { parseOptionalNumber } from '@/lib/marketplace/validation';

const COMMITMENT_TYPES: readonly MarketplaceCommitmentType[] = [
  'Safe',
  'Balanced',
  'Aggressive',
] as const;

const MAX_LISTINGS_PAGE = 1000;
const MAX_COMPLIANCE = 100;
const MIN_COMPLIANCE = 0;
const MAX_LOSS_PERCENT = 100;
const MIN_LOSS_PERCENT = 0;

const IDEMPOTENCY_KEY_HEADER = 'idempotency-key';
const MAX_IDEMPOTENCY_KEY_LENGTH = 128;

interface ParseResult {
  type?: MarketplaceCommitmentType;
  minCompliance?: number;
  maxLoss?: number;
  minAmount?: number;
  maxAmount?: number;
  sortBy?: string;
  page: number;
  pageSize: number;
}

const MARKETPLACE_LISTINGS_CORS_POLICY = {
  GET: { access: 'public' },
  POST: { access: 'first-party' },
} satisfies CorsRoutePolicy;

export const OPTIONS = createCorsOptionsHandler(MARKETPLACE_LISTINGS_CORS_POLICY);

function toMarketplaceCard(listing: MarketplacePublicListing) {
  return {
    id: listing.listingId,
    type: listing.type,
    score: listing.complianceScore,
    amount: `$${listing.amount.toLocaleString()}`,
    duration: `${listing.remainingDays} days`,
    yield: `${listing.currentYield}%`,
    maxLoss: `${listing.maxLoss}%`,
    price: `$${listing.price.toLocaleString()}`,
  };
}

function parseInteger(
  searchParams: URLSearchParams,
  key: string,
  defaultValue: number,
  maxValue?: number,
): number {
  const raw = searchParams.get(key);
  if (raw === null) return defaultValue;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed < 1) {
    throw new ValidationError(`Invalid '${key}' query param. Expected a positive integer.`);
  }
  if (maxValue !== undefined && parsed > maxValue) {
    throw new ValidationError(
      `Invalid '${key}' query param. Must be ${maxValue} or smaller to bound response size.`,
    );
  }
  return parsed;
}

function parseType(searchParams: URLSearchParams): MarketplaceCommitmentType | undefined {
  const raw = searchParams.get('type');
  if (raw === null) return undefined;

  const normalized = raw.trim().toLowerCase();
  const mapping: Record<string, MarketplaceCommitmentType> = {
    safe: 'Safe',
    balanced: 'Balanced',
    aggressive: 'Aggressive',
  };

  if (!(normalized in mapping)) {
    throw new ValidationError(
      `Invalid 'type' query param. Allowed values: ${COMMITMENT_TYPES.join(', ')}.`,
    );
  }

  return mapping[normalized];
}

function parseQuery(searchParams: URLSearchParams): ParseResult {
  const minAmount = parseOptionalNumber(searchParams, 'minAmount');
  const maxAmount = parseOptionalNumber(searchParams, 'maxAmount');
  if (minAmount !== undefined && maxAmount !== undefined && minAmount > maxAmount) {
    throw new ValidationError(
      "Invalid amount filter. 'minAmount' cannot be greater than 'maxAmount'.",
    );
  }
  if (minAmount !== undefined && minAmount < 0) {
    throw new ValidationError("'minAmount' must be non-negative.");
  }
  if (maxAmount !== undefined && maxAmount < 0) {
    throw new ValidationError("'maxAmount' must be non-negative.");
  }

  const minCompliance = parseOptionalNumber(searchParams, 'minCompliance');
  const maxLoss = parseOptionalNumber(searchParams, 'maxLoss');
  if (
    minCompliance !== undefined &&
    (minCompliance < MIN_COMPLIANCE || minCompliance > MAX_COMPLIANCE)
  ) {
    throw new ValidationError(
      `'minCompliance' must be between ${MIN_COMPLIANCE} and ${MAX_COMPLIANCE}.`,
    );
  }
  if (maxLoss !== undefined && (maxLoss < MIN_LOSS_PERCENT || maxLoss > MAX_LOSS_PERCENT)) {
    throw new ValidationError(
      `'maxLoss' must be between ${MIN_LOSS_PERCENT} and ${MAX_LOSS_PERCENT}.`,
    );
  }

  const sortBy = searchParams.get('sortBy') ?? undefined;
  if (sortBy && !isMarketplaceSortBy(sortBy)) {
    throw new ValidationError(
      `Invalid 'sortBy' query param. Allowed values: ${getMarketplaceSortKeys().join(', ')}.`,
    );
  }

  return {
    type: parseType(searchParams),
    minCompliance,
    maxLoss,
    minAmount,
    maxAmount,
    sortBy,
    page: parseInteger(searchParams, 'page', 1, MAX_LISTINGS_PAGE),
    pageSize: parseInteger(searchParams, 'pageSize', 10, MAX_PAGE_SIZE),
  };
}

export const GET = withApiHandler(
  async (req: NextRequest, _context, correlationId) => {
    if (!isFeatureEnabled('marketplace')) {
      return NextResponse.json(
        {
          error: {
            code: 'NOT_FOUND',
            message: 'Marketplace feature is disabled.',
            details: { feature: 'marketplace' },
          },
        },
        { status: 404 },
      );
    }

    const ip = getClientIp(req);
    if (!(await checkRateLimit(ip, 'api/marketplace/listings'))) {
      throw new TooManyRequestsError();
    }

    const { searchParams } = new URL(req.url);
    const filters = parseQuery(searchParams);
    const listings = await listMarketplaceListings(filters);

    const response = {
      listings,
      total: listings.length,
      cards: listings.map(toMarketplaceCard),
    };
    return ok(response, undefined, 200, correlationId);
  },
  { cors: MARKETPLACE_LISTINGS_CORS_POLICY },
);

export const POST = withApiHandler(
  async (req: NextRequest, _context, correlationId) => {
    if (!isFeatureEnabled('marketplace')) {
      return NextResponse.json(
        {
          error: {
            code: 'NOT_FOUND',
            message: 'Marketplace feature is disabled.',
            details: { feature: 'marketplace' },
          },
        },
        { status: 404 },
      );
    }

    assertMutationCsrf(req);

    const auth = verifyAuth(req);
    const sellerAddress = auth.address;

    if (!(await checkRateLimit(sellerAddress, 'api/marketplace/listings/create'))) {
      throw new TooManyRequestsError();
    }

    const body = await parseJsonWithLimit(req, {
      limitBytes: JSON_BODY_LIMITS.marketplaceListingsCreate,
    });

    if (
      typeof body === 'object' &&
      body !== null &&
      !Array.isArray(body) &&
      !('sellerAddress' in body)
    ) {
      (body as Record<string, unknown>).sellerAddress = sellerAddress;
    }

    const parsed = MarketplaceCreateListingBoundarySchema.safeParse(body);
    if (!parsed.success) {
      throw new ValidationError('Invalid listing data', parsed.error.issues);
    }

    const request = parsed.data;
    if (request.sellerAddress && request.sellerAddress !== sellerAddress) {
      assertWalletMatchesSession(sellerAddress, request.sellerAddress, 'sellerAddress');
    }

    const createPayload = {
      commitmentId: request.commitmentId,
      price: request.price,
      currencyAsset: request.currencyAsset,
      sellerAddress: request.sellerAddress ?? sellerAddress,
    };

    const idempotencyKey = req.headers.get(IDEMPOTENCY_KEY_HEADER);
    if (idempotencyKey !== null && idempotencyKey.length > MAX_IDEMPOTENCY_KEY_LENGTH) {
      throw new ValidationError('Idempotency-Key header is too long', [
        {
          path: ['idempotencyKey'],
          message: `Maximum length is ${MAX_IDEMPOTENCY_KEY_LENGTH}`,
        },
      ]);
    }

    if (idempotencyKey !== null) {
      const record = await idempotencyService.getRecord<{
        listing: CreateListingResponse['listing'];
      }>(idempotencyKey);
      if (record) {
        if (record.status === 'COMPLETED') {
          return ok(record.response, undefined, record.statusCode ?? 201, correlationId);
        }
        if (record.status === 'STARTED') {
          throw new TooManyRequestsError(
            'A request with this idempotency key is already in progress.',
          );
        }
      }

      const started = await idempotencyService.start(idempotencyKey);
      if (!started) {
        throw new ConflictError(
          'A concurrent request with this idempotency key is already in progress.',
        );
      }
    }

    let listing: CreateListingResponse['listing'];
    try {
      listing = await marketplaceService.createListing(createPayload as CreateListingRequest);
    } catch (error) {
      if (idempotencyKey !== null) {
        await idempotencyService.fail(idempotencyKey);
      }
      throw error;
    }

    const response: CreateListingResponse = { listing };
    if (idempotencyKey !== null) {
      await idempotencyService.complete(idempotencyKey, response, 201);
    }

    return ok(response, undefined, 201, correlationId);
  },
  { cors: MARKETPLACE_LISTINGS_CORS_POLICY },
);

const _405 = methodNotAllowed(['GET', 'POST']);
export { _405 as PUT, _405 as PATCH, _405 as DELETE };
