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
  holdMinutes: number;
  requiresPrepayment: boolean;
  notificationsEnabled: boolean;
  reminderHoursBefore: number;
  invoicingEnabled: boolean;
  gstin: string | null;
  legalName: string | null;
  legalAddress: string | null;
  stateCode: string | null;
  /** Basis points: 1800 is 18%. */
  gstRateBp: number;
  pricesIncludeGst: boolean;
  sacCode: string | null;
  invoicePrefix: string | null;
}

/** A tax invoice or a credit note, as issued. */
export interface Invoice {
  id: string;
  kind: 'invoice' | 'credit_note';
  reversesId: string | null;
  number: string;
  financialYear: string;
  seq: number;
  issuedAt: string;
  supplierName: string;
  supplierGstin: string | null;
  supplierAddress: string | null;
  supplierStateCode: string | null;
  customerName: string | null;
  customerPhone: string | null;
  customerGstin: string | null;
  placeOfSupply: string | null;
  sacCode: string | null;
  description: string;
  gstRateBp: number;
  taxablePaise: number;
  cgstPaise: number;
  sgstPaise: number;
  igstPaise: number;
  totalPaise: number;
}

/** One message in the venue's outbox, as the owner sees it. */
export interface CustomerMessage {
  id: string;
  template: string;
  preview: string;
  toPhone: string;
  status: 'pending' | 'sent' | 'delivered' | 'read' | 'failed' | 'skipped';
  attempts: number;
  error: string | null;
  provider: string | null;
  createdAt: string;
  sentAt: string | null;
  customerName: string | null;
}

/**
 * Something bookable: a court, or a hall.
 *
 * They share a row because they share the one guarantee that matters — no two
 * bookings on the same thing at the same time — and differ in how they are
 * sold. A court has a sport and an hourly grid; a hall has neither.
 */
export interface Court {
  id: string;
  kind: 'court' | 'hall';
  name: string;
  sport: string | null;
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

export interface CalendarCourt extends Pick<Court, 'id' | 'name' | 'slotMinutes'> {
  /** Always present here: the day grid is courts only. */
  sport: string;
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
  notificationsOptedOut: boolean;
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
  byCourt: { resourceId: string; name: string; sport: string | null; bookings: number; billedPaise: number; bookedMinutes: number }[];
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
  actorType: 'staff' | 'customer' | 'system';
  actorLabel: string | null;
  action: string;
  entityType: string;
  entityId: string | null;
  summary: string;
  data: Record<string, unknown> | null;
  requestId: string | null;
  createdAt: string;
}

/** Someone with a login to this account. */
export interface StaffMember {
  id: string;
  name: string;
  email: string;
  role: 'owner' | 'staff';
  isActive: boolean;
  lastLoginAt: string | null;
  createdAt: string;
}

export interface Invite {
  id: string;
  email: string;
  name: string;
  role: 'owner' | 'staff';
  expiresAt: string;
  createdAt: string;
}

// ------------------------------------------------------------------- halls --

export type EnquiryStatus = 'new' | 'visit_scheduled' | 'quoted' | 'won' | 'lost';

/**
 * Someone asking about the hall.
 *
 * An enquiry never blocks a date — several families can be considering the same
 * Saturday, which is how venues really work. It blocks one only once it turns
 * into a booking, through `POST /enquiries/:id/book`.
 */
export interface Enquiry {
  id: string;
  contactName: string;
  contactPhone: string;
  contactEmail: string | null;
  eventType: string | null;
  /** Absent while it is still "sometime in November". */
  eventDate: string | null;
  guestCount: number | null;
  status: EnquiryStatus;
  visitAt: string | null;
  quotedPaise: number | null;
  lostReason: string | null;
  notes: string | null;
  resourceId: string | null;
  hallName: string | null;
  reservationId: string | null;
  createdAt: string;
}

/** One hall's committed dates over a range. */
export interface HallAvailability {
  timezone: string;
  from: string;
  to: string;
  halls: {
    id: string;
    name: string;
    bookings: {
      id: string;
      status: string;
      /** Set while the date is only tentatively held, and released after it. */
      holdUntil: string | null;
      from: string;
      /** Inclusive: the last day the hall is unavailable. */
      to: string;
      eventFrom: string | null;
      eventTo: string | null;
      customerName: string | null;
    }[];
  }[];
}
