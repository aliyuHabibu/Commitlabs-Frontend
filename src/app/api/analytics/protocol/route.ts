import { NextRequest, NextResponse } from 'next/server';
import {
  applyCorsPolicy,
  createCorsOptionsHandler,
  enforceCorsRequestPolicy,
  toCorsErrorResponse,
  type CorsRoutePolicy,
} from '@/lib/backend/cors';
import { BackendError, normalizeBackendError, toBackendErrorResponse } from '@/lib/backend/errors';
import { isFeatureEnabled } from '@/lib/backend/config';
import { getMockData } from '@/lib/backend/mockDb';
import { methodNotAllowed } from '@/lib/backend/apiResponse';

interface ProtocolAnalyticsResponse {
  totalCommitments: number;
  activeCommitments: number;
  settledCommitments: number;
  violatedCommitments: number;
  totalValueLocked: string;
  totalFeesEarned: string;
  averageComplianceScore: number;
  totalViolations: number;
  uniqueOwners: number;
  snapshot: {
    generatedAt: string;
    window: 'protocol-lifetime';
    source: 'mock' | 'chain';
    rejectedRecords: number;
  };
  invariants: {
    statusTotalsMatch: true;
    nonNegativeTotals: true;
    complianceScoreBounded: true;
  };
  attestationCount?: number;
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
    const normalized = value.trim();
    if (normalized === '') {
      return 0;
    }

    const cleaned = normalized.replace(/[$,%\s]/g, '').replace(/,/g, '');
    const parsed = Number(cleaned);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }

  return Number.NaN;
}

export function buildProtocolAnalytics(
  commitments: Array<Record<string, unknown>> = [],
  sourceOrAttestations?: 'mock' | 'chain' | Array<Record<string, unknown>>,
  maybeAttestations: Array<Record<string, unknown>> = [],
): ProtocolAnalyticsResponse {
  const attestationSet = Array.isArray(sourceOrAttestations)
    ? sourceOrAttestations
    : maybeAttestations;
  const source = Array.isArray(sourceOrAttestations) ? 'mock' : (sourceOrAttestations ?? 'mock');

  let validCommitments = 0;
  let activeCommitments = 0;
  let settledCommitments = 0;
  let violatedCommitments = 0;
  let totalValueLocked = 0;
  let totalFeesEarned = 0;
  let totalViolations = 0;
  let complianceScoreTotal = 0;
  let rejectedRecords = 0;
  const ownerSet = new Set<string>();

  for (const commitment of commitments) {
    const amount = parseNumeric(commitment.amount as string | number | undefined | null);
    const feeEarned = parseNumeric(commitment.feeEarned as string | number | undefined | null);
    const complianceScore = Number(commitment.complianceScore ?? 0);
    const violationCount = Number(commitment.violationCount ?? 0);
    const owner = String(commitment.ownerAddress ?? '').trim();

    if (!Number.isFinite(amount) || amount < 0) {
      rejectedRecords += 1;
      continue;
    }

    if (!Number.isFinite(feeEarned) || feeEarned < 0) {
      rejectedRecords += 1;
      continue;
    }

    if (!Number.isFinite(complianceScore) || complianceScore < 0 || complianceScore > 100) {
      rejectedRecords += 1;
      continue;
    }

    if (
      !Number.isFinite(violationCount) ||
      violationCount < 0 ||
      !Number.isInteger(violationCount)
    ) {
      rejectedRecords += 1;
      continue;
    }

    validCommitments += 1;
    totalValueLocked += amount;
    totalFeesEarned += feeEarned;
    totalViolations += violationCount;
    complianceScoreTotal += complianceScore;

    const status = String(commitment.status ?? '').toLowerCase();
    if (status === 'active') {
      activeCommitments += 1;
    }
    if (status === 'settled') {
      settledCommitments += 1;
    }
    if (status === 'violated') {
      violatedCommitments += 1;
    }

    if (owner) {
      ownerSet.add(owner);
    }
  }

  const averageComplianceScore =
    validCommitments === 0 ? 0 : Number((complianceScoreTotal / validCommitments).toFixed(2));

  const invariants = {
    statusTotalsMatch:
      activeCommitments + settledCommitments + violatedCommitments <= validCommitments,
    nonNegativeTotals: totalValueLocked >= 0 && totalFeesEarned >= 0 && totalViolations >= 0,
    complianceScoreBounded: true,
  } satisfies ProtocolAnalyticsResponse['invariants'];

  return {
    totalCommitments: validCommitments,
    activeCommitments,
    settledCommitments,
    violatedCommitments,
    totalValueLocked: totalValueLocked.toFixed(2),
    totalFeesEarned: totalFeesEarned.toFixed(2),
    averageComplianceScore,
    totalViolations,
    uniqueOwners: ownerSet.size,
    snapshot: {
      generatedAt: new Date().toISOString(),
      window: 'protocol-lifetime',
      source,
      rejectedRecords,
    },
    invariants,
    attestationCount: attestationSet.length,
  };
}

export async function GET(req: NextRequest) {
  try {
    enforceCorsRequestPolicy(req, ANALYTICS_PROTOCOL_CORS_POLICY);
  } catch (error) {
    return toCorsErrorResponse(error);
  }

  if (!isFeatureEnabled('analyticsProtocol')) {
    const error = new BackendError({
      code: 'NOT_FOUND',
      message: 'Protocol analytics endpoint is disabled.',
      status: 404,
      details: { feature: 'analyticsProtocol' },
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
      'mock',
      (data.attestations ?? []) as Array<Record<string, unknown>>,
    );

    return applyCorsPolicy(req, NextResponse.json(analytics), ANALYTICS_PROTOCOL_CORS_POLICY);
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
