import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import type { MarketplaceCardProps } from '@/components/MarketplaceCard';

export type ListingsFetchState =
  | 'IDLE'
  | 'LOADING_INITIAL'
  | 'LOADING_MORE'
  | 'SUCCESS'
  | 'EXHAUSTED'
  | 'ERROR_EMPTY'
  | 'ERROR_STALE';

interface ListingsError {
  message: string;
  code?: string;
  retryable: boolean;
  retryAfterSeconds?: number;
}

interface UsePaginatedListingsResult {
  state: ListingsFetchState;
  isLoading: boolean;
  isLoadingInitial: boolean;
  listings: MarketplaceCardProps[];
  page: number;
  hasMore: boolean;
  error: ListingsError | null;
  retryCount: number;
  generation: number;
  refresh: (force?: boolean) => Promise<void>;
  loadMore: () => Promise<void>;
}

interface RawListingItem {
  listingId: string;
  type: string;
  complianceScore: number;
  amount: number;
  remainingDays: number;
  currentYield: number;
  maxLoss: number;
  price: number;
}

const CLIENT_MAX_RETRIES = 2;

function mapItem(raw: RawListingItem): MarketplaceCardProps {
  return {
    id: raw.listingId,
    type: raw.type as MarketplaceCardProps['type'],
    score: raw.complianceScore,
    amount: String(raw.amount),
    duration: `${raw.remainingDays}d`,
    yield: `${raw.currentYield}%`,
    maxLoss: `${raw.maxLoss}%`,
    price: String(raw.price),
  };
}

function parseErrorBody(body: unknown, status: number): ListingsError {
  const errObj =
    body && typeof body === 'object' && 'error' in body
      ? (body as { error?: Record<string, unknown> }).error
      : null;

  return {
    code: (errObj && typeof errObj.code === 'string' ? errObj.code : undefined) ?? `HTTP_${status}`,
    message:
      (errObj && typeof errObj.message === 'string' ? errObj.message : undefined) ??
      `Request failed with status ${status}`,
    retryable: status >= 500 || (errObj && (errObj as { retryable?: unknown }).retryable === true),
    retryAfterSeconds:
      typeof (errObj as { retryAfterSeconds?: unknown } | undefined)?.retryAfterSeconds === 'number'
        ? (errObj as { retryAfterSeconds: number }).retryAfterSeconds
        : undefined,
  };
}

export function usePaginatedListings(
  params: Record<string, unknown> = {},
  pageSize: number = 9,
  disabled: boolean = false,
): UsePaginatedListingsResult {
  const serializedParams = JSON.stringify(params);

  const [listings, setListings] = useState<MarketplaceCardProps[]>([]);
  const [page, setPage] = useState(1);
  const [state, setState] = useState<ListingsFetchState>('IDLE');
  const [hasMore, setHasMore] = useState(true);
  const [error, setError] = useState<ListingsError | null>(null);
  const [retryCount, setRetryCount] = useState(0);
  const [generation, setGeneration] = useState(0);

  const generationRef = useRef(0);
  const abortRef = useRef<AbortController | null>(null);
  const fetchingRef = useRef(false);
  const hasHadListingsRef = useRef(false);
  const mountedRef = useRef(false);
  const firstRenderRef = useRef(true);
  const paramsRef = useRef(params);

  paramsRef.current = params;

  const isLoading = state === 'LOADING_INITIAL' || state === 'LOADING_MORE';
  const isLoadingInitial = state === 'LOADING_INITIAL';

  if (!disabled && firstRenderRef.current && state === 'IDLE') {
    setState('LOADING_INITIAL');
  }
  firstRenderRef.current = false;

  const bumpGeneration = useCallback((): number => {
    generationRef.current += 1;
    setGeneration(generationRef.current);
    return generationRef.current;
  }, []);

  const abortCurrent = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
  }, []);

  const doFetch = useCallback(
    async (
      fetchPage: number,
      myGeneration: number,
      abortController: AbortController,
      isLoadMore: boolean,
    ): Promise<void> => {
      fetchingRef.current = true;
      setState(isLoadMore ? 'LOADING_MORE' : 'LOADING_INITIAL');
      setError(null);

      let attempt = 0;
      let lastErr: ListingsError | null = null;
      const currentParams = paramsRef.current;

      while (attempt <= CLIENT_MAX_RETRIES) {
        if (abortController.signal.aborted) break;
        if (myGeneration !== generationRef.current) break;
        attempt += 1;

        try {
          const searchParams = new URLSearchParams({
            page: String(fetchPage),
            pageSize: String(pageSize),
            ...currentParams,
          });

          const res = await fetch(`/api/marketplace/listings?${searchParams.toString()}`, {
            signal: abortController.signal,
          });

          if (abortController.signal.aborted) break;
          if (myGeneration !== generationRef.current) break;

          const body = await res.json().catch(() => null);

          const isOk =
            res.ok &&
            body &&
            typeof body === 'object' &&
            (body as { success?: unknown }).success === true;

          if (!isOk) {
            lastErr = parseErrorBody(body, res.status);
            if (!lastErr.retryable || attempt > CLIENT_MAX_RETRIES) break;
            await Promise.resolve();
            continue;
          }

          const data = (body as { data?: { items?: unknown } }).data;
          const rawItems: RawListingItem[] = Array.isArray(data?.items)
            ? (data.items as RawListingItem[])
            : [];

          const mapped = rawItems.map(mapItem);

          if (fetchPage === 1) {
            const seen = new Set<string>();
            const deduped = mapped.filter((item) => {
              if (seen.has(item.id)) return false;
              seen.add(item.id);
              return true;
            });
            setListings(deduped);
            if (deduped.length > 0) hasHadListingsRef.current = true;
          } else {
            setListings((prev) => {
              const existingIds = new Set(prev.map((item) => item.id));
              const filtered = mapped.filter((item) => !existingIds.has(item.id));
              return [...prev, ...filtered];
            });
            if (mapped.length > 0) hasHadListingsRef.current = true;
          }

          if (rawItems.length < pageSize) {
            setHasMore(false);
            setState('EXHAUSTED');
          } else {
            setState('SUCCESS');
          }

          setRetryCount(attempt - 1);
          break;
        } catch (fetchErr: unknown) {
          if (abortController.signal.aborted) break;
          if (myGeneration !== generationRef.current) break;

          lastErr = {
            code: 'NETWORK_ERROR',
            message: fetchErr instanceof Error ? fetchErr.message : 'Unknown fetch error',
            retryable: attempt <= CLIENT_MAX_RETRIES,
          };

          if (attempt > CLIENT_MAX_RETRIES) break;
          await Promise.resolve();
        }
      }

      if (abortRef.current === abortController) {
        abortRef.current = null;
      }

      if (abortController.signal.aborted || myGeneration !== generationRef.current) return;

      fetchingRef.current = false;
      setRetryCount(Math.max(0, attempt - 1));

      if (lastErr) {
        setError(lastErr);
        setHasMore(false);
        setState(hasHadListingsRef.current ? 'ERROR_STALE' : 'ERROR_EMPTY');
      }
    },
    [pageSize],
  );

  const refresh = useCallback(
    async (_force?: boolean): Promise<void> => {
      abortCurrent();
      const gen = bumpGeneration();
      setPage(1);
      setListings([]);
      hasHadListingsRef.current = false;
      setHasMore(true);
      setError(null);
      const controller = new AbortController();
      abortRef.current = controller;
      await doFetch(1, gen, controller, false);
    },
    [abortCurrent, bumpGeneration, doFetch],
  );

  const loadMore = useCallback(async (): Promise<void> => {
    if (fetchingRef.current || !hasMore) return;
    setPage((prev) => prev + 1);
  }, [hasMore]);

  const prevSerializedParamsRef = useRef(serializedParams);

  useEffect(() => {
    if (serializedParams !== prevSerializedParamsRef.current) {
      prevSerializedParamsRef.current = serializedParams;
      abortCurrent();
      bumpGeneration();
      setPage(1);
      setListings([]);
      hasHadListingsRef.current = false;
      setHasMore(true);
      setError(null);
      setRetryCount(0);
    }
  }, [serializedParams, abortCurrent, bumpGeneration]);

  useEffect(() => {
    if (disabled) {
      setState('IDLE');
      return;
    }

    mountedRef.current = true;
    const controller = new AbortController();
    abortRef.current = controller;

    const gen = generationRef.current;
    doFetch(page, gen, controller, page > 1).catch(() => {});

    return () => {
      controller.abort();
    };
  }, [page, serializedParams, pageSize, disabled, doFetch]);

  useEffect(() => {
    return () => {
      abortRef.current?.abort();
    };
  }, []);

  return useMemo(
    () => ({
      state,
      isLoading,
      isLoadingInitial,
      listings,
      page,
      hasMore,
      error,
      retryCount,
      generation,
      refresh,
      loadMore,
    }),
    [
      state,
      isLoading,
      isLoadingInitial,
      listings,
      page,
      hasMore,
      error,
      retryCount,
      generation,
      refresh,
      loadMore,
    ],
  );
}
