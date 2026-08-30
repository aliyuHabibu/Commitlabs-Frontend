'use client';

import React, {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
} from 'react';
import Link from 'next/link';
import Image from 'next/image';
import { AlertCircle, ArrowLeft, Loader2, Search } from 'lucide-react';
import styles from './MarketplaceHeader.module.css';
import { apiFetch, apiGet } from '@/lib/apiClient';

export interface CommitmentSearchResult {
  commitmentId: string;
  ownerAddress: string;
  asset: string;
  amount: string;
  status: string;
  riskType: string;
  complianceScore: number;
  currentValue: string;
  createdAt: string;
  expiresAt: string;
}

interface MarketplaceStats {
  activeListings: number;
  averageYield: number;
  medianPrice: number;
}

const SORT_OPTIONS = [
  { value: 'popular', label: 'Most Popular' },
  { value: 'newest', label: 'Newest' },
  { value: 'priceLow', label: 'Price: Low to High' },
  { value: 'priceHigh', label: 'Price: High to Low' },
] as const;

type SortValue = (typeof SORT_OPTIONS)[number]['value'];

export interface MarketplaceHeaderProps {
  onSearchChange?: (query: string) => void;
  searchDebounceMs?: number;
  searchPlaceholder?: string;
  backHref?: string;
  createHref?: string;
  searchQuery?: string;
  ownerAddress?: string;
  onResultSelect?: (item: CommitmentSearchResult) => void;
}

const DEFAULT_PLACEHOLDER = 'Search commitments…';

export function MarketplaceHeader({
  onSearchChange,
  searchDebounceMs = 300,
  searchPlaceholder = DEFAULT_PLACEHOLDER,
  backHref = '/',
  createHref = '/create',
  searchQuery: controlledQuery,
  ownerAddress,
  onResultSelect,
}: MarketplaceHeaderProps) {
  const [stats, setStats] = useState<MarketplaceStats | null>(null);
  const [statsError, setStatsError] = useState<string | null>(null);
  const [sortValue, setSortValue] = useState<SortValue>('popular');
  const [query, setQuery] = useState(controlledQuery ?? '');
  const [results, setResults] = useState<CommitmentSearchResult[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [isDropdownOpen, setIsDropdownOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);

  const abortRef = useRef<AbortController | null>(null);
  const uid = useId();
  const listboxId = `${uid}-listbox`;

  useEffect(() => {
    let cancelled = false;

    const fetchStats = async () => {
      try {
        const data = await apiGet<MarketplaceStats>('/api/marketplace/stats');
        if (!cancelled) {
          setStats(data);
        }
      } catch (error) {
        if (!cancelled) {
          setStatsError((error as Error).message);
        }
      }
    };

    void fetchStats();

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const trimmed = query.trim();

    if (!trimmed) {
      abortRef.current?.abort();
      setResults([]);
      setIsDropdownOpen(false);
      setActiveIndex(-1);
      onSearchChange?.('');
      return;
    }

    const timerId = window.setTimeout(() => {
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;

      setIsSearching(true);
      setSearchError(null);

      const params = new URLSearchParams({
        ownerAddress: ownerAddress ?? 'marketplace',
        asset: trimmed,
      });

      apiFetch<{ data?: CommitmentSearchResult[] }>(`/api/commitments/search?${params}`, {
        signal: controller.signal,
      })
        .then((data) => {
          setResults(data.data ?? []);
          setIsDropdownOpen(true);
          setActiveIndex(-1);
          setIsSearching(false);
        })
        .catch((error: unknown) => {
          if ((error as { name?: string }).name !== 'AbortError') {
            setSearchError((error as Error).message || String(error));
            setIsDropdownOpen(false);
            setIsSearching(false);
          }
        });

      onSearchChange?.(trimmed);
    }, searchDebounceMs);

    return () => clearTimeout(timerId);
  }, [query, searchDebounceMs, ownerAddress, onSearchChange]);

  const handleSelect = useCallback(
    (item: CommitmentSearchResult) => {
      setQuery(item.asset);
      setIsDropdownOpen(false);
      setActiveIndex(-1);
      onResultSelect?.(item);
      onSearchChange?.(item.asset);
    },
    [onResultSelect, onSearchChange],
  );

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLInputElement>) => {
      if (!isDropdownOpen) {
        return;
      }

      switch (event.key) {
        case 'ArrowDown':
          event.preventDefault();
          setActiveIndex((index) => Math.min(index + 1, results.length - 1));
          break;
        case 'ArrowUp':
          event.preventDefault();
          setActiveIndex((index) => Math.max(index - 1, 0));
          break;
        case 'Enter':
          event.preventDefault();
          if (activeIndex >= 0 && results[activeIndex]) {
            handleSelect(results[activeIndex]);
          }
          break;
        case 'Escape':
          event.preventDefault();
          setIsDropdownOpen(false);
          setActiveIndex(-1);
          break;
        default:
          break;
      }
    },
    [activeIndex, handleSelect, isDropdownOpen, results],
  );

  const handleBlur = useCallback(() => {
    const id = window.setTimeout(() => {
      setIsDropdownOpen(false);
      setActiveIndex(-1);
    }, 150);

    return () => clearTimeout(id);
  }, []);

  const activeDescendant = activeIndex >= 0 ? `${listboxId}-option-${activeIndex}` : undefined;

  return (
    <header className={styles.root} role="banner">
      <div className={styles.inner}>
        <div className={styles.contentBlock}>
          <Link href={backHref} className={styles.backLink} aria-label="Back to Home">
            <ArrowLeft aria-hidden width={16} height={16} />
            Back to Home
          </Link>
          <div className={styles.headingWrap}>
            <span className={styles.headingGlow} aria-hidden />
            <h1 className={styles.title}>Commitment Marketplace</h1>
          </div>
          <p className={styles.subheading}>Browse and trade verified liquidity commitments</p>
        </div>

        <div className={styles.controlsBlock}>
          <div className={styles.searchWrap}>
            <label htmlFor="marketplace-search" className={styles.srOnly}>
              Search commitments
            </label>
            <Search className={styles.searchIcon} aria-hidden width={18} height={18} />

            <input
              id="marketplace-search"
              role="combobox"
              type="search"
              className={styles.searchInput}
              placeholder={searchPlaceholder}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={handleKeyDown}
              onFocus={() => {
                if (results.length > 0) {
                  setIsDropdownOpen(true);
                }
              }}
              onBlur={handleBlur}
              aria-label="Search commitments"
              aria-autocomplete="list"
              aria-expanded={isDropdownOpen}
              aria-controls={listboxId}
              aria-activedescendant={activeDescendant}
              aria-busy={isSearching}
              autoComplete="off"
            />

            {isSearching && (
              <span className={styles.searchSpinner} aria-hidden>
                <Loader2 size={14} className={styles.spinnerIcon} />
              </span>
            )}

            <ul
              id={listboxId}
              role="listbox"
              aria-label="Search results"
              className={`${styles.dropdown} ${isDropdownOpen ? styles.dropdownVisible : ''}`}
              hidden={!isDropdownOpen}
            >
              {results.length === 0 ? (
                <li role="option" aria-selected={false} className={styles.dropdownEmpty}>
                  No results found
                </li>
              ) : (
                results.map((item, index) => (
                  <li
                    key={item.commitmentId}
                    id={`${listboxId}-option-${index}`}
                    role="option"
                    aria-selected={index === activeIndex}
                    className={`${styles.dropdownItem} ${index === activeIndex ? styles.dropdownItemActive : ''}`}
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => handleSelect(item)}
                  >
                    <span className={styles.dropdownItemAsset}>{item.asset}</span>
                    <span className={styles.dropdownItemMeta}>
                      {item.riskType} · {item.amount}
                    </span>
                  </li>
                ))
              )}
            </ul>

            {searchError && !isDropdownOpen && (
              <div className={styles.searchError} role="alert">
                <AlertCircle size={12} aria-hidden />
                {searchError}
              </div>
            )}
          </div>

          {stats && (
            <div className={styles.statsSummary} aria-live="polite">
              <span className={styles.statItem}>Listings: {stats.activeListings}</span>
              <span className={styles.statItem}>Avg Yield: {stats.averageYield}%</span>
              <span className={styles.statItem}>Median Price: ${stats.medianPrice}</span>
            </div>
          )}
          {statsError && <div className={styles.error}>Error: {statsError}</div>}

          <div className={styles.sortControl}>
            <label htmlFor="marketplace-sort" className={styles.srOnly}>
              Sort marketplace
            </label>
            <select
              id="marketplace-sort"
              className={styles.sortSelect}
              value={sortValue}
              onChange={(event) => setSortValue(event.target.value as SortValue)}
              aria-label="Sort marketplace"
            >
              {SORT_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </div>

          <Link href={createHref} className={styles.createButton} aria-label="Create commitment">
            <Image
              src="/plus.png"
              alt=""
              width={18}
              height={18}
              className={styles.createButtonIcon}
              aria-hidden
            />
            <span className={styles.createButtonLabel}>Create</span>
          </Link>
        </div>
      </div>
    </header>
  );
}
