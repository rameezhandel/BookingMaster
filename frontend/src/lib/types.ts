export interface Venue {
  id: string;
  name: string;
  timezone: string;
  address: string | null;
  phone: string | null;
  slug: string | null;
  isPublished: boolean;
  bookingWindowDays: number;
  minNoticeMinutes: number;
}

export interface Court {
  id: string;
  name: string;
  sport: string;
  slotMinutes: number;
  isActive: boolean;
  sortOrder: number;
}

/** One open window on one weekday. A day may have more than one. */
export interface HourWindow {
  id?: string;
  dayOfWeek: number;
  opensAt: string;
  closesAt: string;
}

export interface DateOverride {
  id: string;
  venueId: string;
  resourceId: string | null;
  onDate: string;
  isClosed: boolean;
  opensAt: string | null;
  closesAt: string | null;
  reason: string | null;
}

export interface PriceRule {
  id: string;
  name: string;
  days: number[];
  startsAt: string;
  endsAt: string;
  pricePerHourPaise: number;
  priority: number;
  validFrom: string | null;
  validTo: string | null;
  isActive: boolean;
}

export interface ReservationSummary {
  id: string;
  kind: 'booking' | 'block';
  status: string;
  start: string;
  end: string;
  amountPaise: number;
  paidPaise: number;
  duePaise: number;
  notes: string | null;
  blockReason: string | null;
  seriesId: string | null;
  customer: { id: string; name: string; phone: string } | null;
}

export type SlotState = 'free' | 'booked' | 'held' | 'blocked' | 'past';

export interface Slot {
  start: string;
  end: string;
  label: string;
  state: SlotState;
  pricePaise: number | null;
  reservation: ReservationSummary | null;
}

export interface CalendarCourt extends Pick<Court, 'id' | 'name' | 'sport' | 'slotMinutes'> {
  closed: boolean;
  closedReason: string | null;
  openingSource: 'weekly' | 'venue-override' | 'court-override';
  windows: { opensAt: string; closesAt: string }[];
  slots: Slot[];
  offGrid: ReservationSummary[];
}

export interface CalendarDay {
  date: string;
  timezone: string;
  venue: { id: string; name: string };
  courts: CalendarCourt[];
  summary: { totalSlots: number; bookedSlots: number; occupancyPct: number; bookedPaise: number };
}

export interface WeekDay {
  date: string;
  bookedSlots: number;
  totalSlots: number;
  occupancyPct: number;
  closed: boolean;
}

export interface Customer {
  id: string;
  name: string;
  phone: string;
  notes: string | null;
}

export interface BookingRow {
  id: string;
  kind: 'booking' | 'block';
  status: string;
  during: { start: string; end: string };
  amountPaise: number;
  paidPaise: number;
  duePaise: number;
  notes: string | null;
  blockReason: string | null;
  resourceName: string;
  sport: string;
  venueName: string;
  timezone: string;
  customerName: string | null;
  customerPhone: string | null;
  cancellationRefundPct: number | null;
  cancellationRefundPaise: number | null;
  cancellationReason: string | null;
}

export interface Payment {
  id: string;
  amountPaise: number;
  direction: 'in' | 'refund';
  method: 'cash' | 'upi' | 'card' | 'bank_transfer' | 'other';
  reference: string | null;
  note: string | null;
  receivedAt: string;
}

export interface ReportSummary {
  from: string;
  to: string;
  bookings: number;
  cancelled: number;
  noShows: number;
  billedPaise: number;
  collectedPaise: number;
  outstandingPaise: number;
  byCourt: { resourceId: string; name: string; sport: string; bookings: number; billedPaise: number; bookedMinutes: number }[];
}

export interface BookingSeries {
  id: string;
  dayOfWeek: number;
  startsAt: string;
  durationMinutes: number;
  startsOn: string;
  endsOn: string | null;
  amountPaise: number | null;
  notes: string | null;
  status: 'active' | 'ended';
  materialisedThrough: string | null;
  resourceId: string;
  resourceName: string;
  sport: string;
  venueId: string;
  timezone: string;
  customerId: string | null;
  customerName: string | null;
  customerPhone: string | null;
  upcoming: number;
}

export interface SeriesOccurrence {
  id: string;
  occurrenceDate: string;
  during: { start: string; end: string };
  status: string;
  amountPaise: number;
}

export interface SeriesDetail extends BookingSeries {
  occurrences: SeriesOccurrence[];
}

export interface MaterialiseResult {
  created: { date: string; reservationId: string; amountPaise: number }[];
  skipped: { date: string; reason: 'clash' | 'closed' | 'outside-hours' | 'already-booked'; detail: string }[];
  materialisedThrough: string;
}

export interface CreateSeriesResult extends MaterialiseResult {
  series: BookingSeries;
}

export interface CancellationTier {
  minHoursBefore: number;
  refundPct: number;
}

export interface RefundQuote {
  configured: boolean;
  refundPct: number | null;
  refundPaise: number;
  hoursBefore: number;
  tier: CancellationTier | null;
  cappedByPaid: boolean;
}

/** Keyset-paginated list response. */
export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

export interface AuditEvent {
  id: number;
  actorEmail: string | null;
  action: string;
  entityType: string;
  entityId: string | null;
  summary: string;
  data: Record<string, unknown> | null;
  requestId: string | null;
  createdAt: string;
}
