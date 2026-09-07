import { useQuery } from '@tanstack/react-query';
import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';
import { get } from './api';
import type { Venue } from './types';

const VENUE_KEY = 'bm.venue';

function remember(id: string) {
  try {
    localStorage.setItem(VENUE_KEY, id);
  } catch {
    /* private browsing: the choice just won't persist */
  }
}

function recall(): string | null {
  try {
    return localStorage.getItem(VENUE_KEY);
  } catch {
    return null;
  }
}

interface VenueValue {
  venues: Venue[];
  /** The venue every page is currently showing. Undefined only before the first load. */
  venue: Venue | undefined;
  timezone: string;
  isLoading: boolean;
  select: (id: string) => void;
}

const VenueContext = createContext<VenueValue | null>(null);

/**
 * One selected venue, shared by every page.
 *
 * Pages used to reach for `venues[0]`, which quietly showed an operator with two
 * venues the wrong one's bookings and revenue while the calendar showed the
 * other. The choice lives here and is remembered between sessions.
 */
export function VenueProvider({ children }: { children: ReactNode }) {
  const [selectedId, setSelectedId] = useState<string | null>(recall());

  const { data: venues = [], isLoading } = useQuery({
    queryKey: ['venues'],
    queryFn: () => get<Venue[]>('/venues'),
  });

  const select = useCallback((id: string) => {
    setSelectedId(id);
    remember(id);
  }, []);

  const value = useMemo<VenueValue>(() => {
    const venue = venues.find((v) => v.id === selectedId) ?? venues[0];
    return {
      venues,
      venue,
      timezone: venue?.timezone ?? 'Asia/Kolkata',
      isLoading,
      select,
    };
  }, [venues, selectedId, isLoading, select]);

  return <VenueContext.Provider value={value}>{children}</VenueContext.Provider>;
}

export function useVenue() {
  const ctx = useContext(VenueContext);
  if (!ctx) throw new Error('useVenue must be used inside VenueProvider');
  return ctx;
}

/** The switcher shown in the top bar once an operator has more than one venue. */
export function VenueSwitcher() {
  const { venues, venue, select } = useVenue();
  if (venues.length < 2) return null;

  return (
    <select
      value={venue?.id ?? ''}
      onChange={(e) => select(e.target.value)}
      style={{ width: 'auto' }}
      aria-label="Venue"
    >
      {venues.map((v) => (
        <option key={v.id} value={v.id}>
          {v.name}
        </option>
      ))}
    </select>
  );
}
