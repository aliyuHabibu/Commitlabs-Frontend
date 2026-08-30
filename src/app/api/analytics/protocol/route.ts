import { NextRequest, NextResponse } from 'next/server';
import {
  applyCorsPolicy,
  createCorsOptionsHandler,
  enforceCorsRequestPolicy,
  toCorsErrorResponse,
  type CorsRoutePolicy,
} from '@/lib/backend/cors';
import {
  BackendError,
  normalizeBackendError,
  toBackendErrorResponse,
} from '@/lib/backend/errors';
import { isFeatureEnabled } from '@/lib/backend/config';
import { getMockData } from '@/lib/backend/mockDb';
import { methodNotAllowed } from '@/lib/backend/apiResponse';

interface ProtocolAnalyticsResponse {
  totalCommitments: number;
  activeCommitments: number;
  settledCommitments: number;
  totalValueCommitted: string;
  feesEarned: string;
  averageComplianceScore: number;
  violationCount: number;
  attestationCount: number;
}

const ANALYTICS_PROTOCOL_CORS_POLICY = {
  GET: { access: 'first-party' },
} satisfies CorsRoutePolicy;

export const OPTIONS = createCorsOptionsHandler(ANALYTICS_PROTOCOL_CORS_POLICY);

function parseNumeric(value: string | number | undefined | null): number {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === 'string') {
    const normalized = value.replace(/[$,%\s]/g, '').replace(/,/g, '');
    const parsed = Number(normalized);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }

  return 0;
}

function sumNumericField(
  values: Array<Record<string, unknown>>,
  field: 'amount' | 'feeEarned',
): string {
  const total = values.reduce((acc, value) => {
    const numericValue = parseNumeric(value[field] as string | number | undefined | null);
    return acc + numericValue;
  }, 0);

  return total.toFixed(2);
}

function buildProtocolAnalytics(
  commitments: Array<Record<string, unknown>>,
  attestations: Array<Record<string, unknown>>,
): ProtocolAnalyticsResponse {
  const totalCommitments = commitments.length;
  const activeCommitments = commitments.filter((commitment) => {
    const status = String(commitment.status ?? '').toLowerCase();
    return status === 'active' || status === 'created';
  }).length;
  const settledCommitments = commitments.filter((commitment) => {
    const status = String(commitment.status ?? '').toLowerCase();
    return status === 'settled';
  }).length;
  const totalValueCommitted = sumNumericField(commitments, 'amount');
  const feesEarned = sumNumericField(commitments, 'feeEarned');
  const averageComplianceScore =
    totalCommitments === 0
      ? 0
      : Number(
          (
            commitments.reduce((acc, commitment) => {
              const score = Number(commitment.complianceScore ?? 0);
              return acc + score;
            }, 0) / totalCommitments
          ).toFixed(2),
        );
  const violationCount = commitments.reduce((acc, commitment) => {
    return acc + Number(commitment.violationCount ?? 0);
  }, 0);

  return {
    totalCommitments,
    activeCommitments,
    settledCommitments,
    totalValueCommitted,
    feesEarned,
    averageComplianceScore,
    violationCount,
    attestationCount: attestations.length,
  };
}

export async function GET(req: NextRequest) {
  try {
    enforceCorsRequestPolicy(req, ANALYTICS_PROTOCOL_CORS_POLICY);
  } catch (error) {
    return toCorsErrorResponse(error);
  }

  if (!isFeatureEnabled('analyticsUser')) {
    const error = new BackendError({
      code: 'NOT_FOUND',
      message: 'Protocol analytics endpoint is disabled.',
      status: 404,
      details: { feature: 'analyticsUser' },
    });

    return applyCorsPolicy(
      req,
      NextResponse.json(toBackendErrorResponse(error), {
        status: error.status,
      }),
      ANALYTICS_PROTOCOL_CORS_POLICY,
    );
  }

  try {
    const data = await getMockData();
    const analytics = buildProtocolAnalytics(
      (data.commitments ?? []) as Array<Record<string, unknown>>,
      (data.attestations ?? []) as Array<Record<string, unknown>>,
    );

    return applyCorsPolicy(
      req,
      NextResponse.json(analytics),
      ANALYTICS_PROTOCOL_CORS_POLICY,
    );
  } catch (error) {
    const normalized = normalizeBackendError(error, {
      code: 'INTERNAL_ERROR',
      message: 'Failed to compute protocol analytics.',
      status: 500,
    });

    return applyCorsPolicy(
      req,
      NextResponse.json(toBackendErrorResponse(normalized), {
        status: normalized.status,
      }),
      ANALYTICS_PROTOCOL_CORS_POLICY,
    );
  }
}

const _405 = methodNotAllowed(['GET']);
export { _405 as POST, _405 as PUT, _405 as PATCH, _405 as DELETE };
