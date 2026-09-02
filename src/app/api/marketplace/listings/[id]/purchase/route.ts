import { NextRequest, NextResponse } from 'next/server';
import { ok, methodNotAllowed } from '@/lib/backend/apiResponse';
import { isFeatureEnabled } from '@/lib/backend/config';
import { assertMutationCsrf } from '@/lib/backend/csrf';
import { createCorsOptionsHandler, type CorsRoutePolicy } from '@/lib/backend/cors';
import { ConflictError, TooManyRequestsError, ValidationError } from '@/lib/backend/errors';
import { idempotencyService } from '@/lib/backend/idempotency';
import { parseJsonWithLimit, JSON_BODY_LIMITS } from '@/lib/backend/jsonBodyLimit';
import { checkRateLimit } from '@/lib/backend/rateLimit';
import { verifyAuth } from '@/lib/backend/requireAuth';
import {
  assertWalletMatchesSession,
  ListingIdSchema,
  MarketplacePurchaseBoundarySchema,
} from '@/lib/backend/marketplaceBoundary';
import { withApiHandler } from '@/lib/backend/withApiHandler';
import { marketplaceService } from '@/lib/backend/services/marketplace';
import { transferOwnership } from '@/lib/backend/services/contracts';
import { appendAuditEvent } from '@/lib/backend/auditLog';

const IDEMPOTENCY_KEY_HEADER = 'idempotency-key';
const MAX_IDEMPOTENCY_KEY_LENGTH = 128;

const MARKETPLACE_PURCHASE_CORS_POLICY = {
  POST: { access: 'first-party' },
} satisfies CorsRoutePolicy;

export const OPTIONS = createCorsOptionsHandler(MARKETPLACE_PURCHASE_CORS_POLICY);

export const POST = withApiHandler(
  async (req: NextRequest, context: { params: { id: string } }, correlationId) => {
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
    const buyerAddress = auth.address;

    if (!(await checkRateLimit(buyerAddress, 'api/marketplace/listings/purchase'))) {
      throw new TooManyRequestsError();
    }

    const listingIdResult = ListingIdSchema.safeParse(context.params.id);
    if (!listingIdResult.success) {
      throw new ValidationError('Invalid listing ID', listingIdResult.error.issues);
    }
    const listingId = listingIdResult.data;

    const body = await parseJsonWithLimit(req, {
      limitBytes: JSON_BODY_LIMITS.marketplacePurchase,
    });

    const parsed = MarketplacePurchaseBoundarySchema.safeParse(body);
    if (!parsed.success) {
      throw new ValidationError('Invalid purchase data', parsed.error.issues);
    }

    const request = parsed.data;
    if (request.buyerAddress !== buyerAddress) {
      assertWalletMatchesSession(buyerAddress, request.buyerAddress, 'buyerAddress');
    }

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
      const record = await idempotencyService.getRecord<{ data: unknown }>(idempotencyKey);
      if (record) {
        if (record.status === 'COMPLETED') {
          return ok(record.response, undefined, record.statusCode ?? 200, correlationId);
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

    try {
      const listing = await marketplaceService.completePurchase(listingId, request.buyerAddress);

      const transfer = await transferOwnership({
        commitmentId: listing.commitmentId,
        fromAddress: listing.sellerAddress,
        toAddress: request.buyerAddress,
      });

      await appendAuditEvent({
        category: 'marketplace',
        action: 'marketplace.purchase',
        severity: 'info',
        actor: request.buyerAddress,
        resourceId: listingId,
        metadata: {
          listingId: listing.id,
          commitmentId: listing.commitmentId,
          price: listing.price,
          currencyAsset: listing.currencyAsset,
          buyerAddress: request.buyerAddress,
          sellerAddress: listing.sellerAddress,
          txHash: transfer.txHash ?? null,
        },
      });

      const response = {
        listingId: listing.id,
        commitmentId: listing.commitmentId,
        buyerAddress: request.buyerAddress,
        sellerAddress: listing.sellerAddress,
        txHash: transfer.txHash ?? null,
        purchasedAt: listing.updatedAt,
      };

      if (idempotencyKey !== null) {
        await idempotencyService.complete(idempotencyKey, { data: response }, 200);
      }

      return ok(response, undefined, 200, correlationId);
    } catch (error) {
      if (idempotencyKey !== null) {
        await idempotencyService.fail(idempotencyKey);
      }
      throw error;
    }
  },
  { cors: MARKETPLACE_PURCHASE_CORS_POLICY },
);

const _405 = methodNotAllowed(['POST']);
export { _405 as GET, _405 as PUT, _405 as PATCH, _405 as DELETE };
