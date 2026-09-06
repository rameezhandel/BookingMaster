export interface Venue {
  id: string;
  name: string;
  timezone: string;
  address: string | null;
  phone: string | null;
}

export interface Court {
  id: string;
  name: string;
  sport: string;
  slotMinutes: number;
  opensAt: string;
  closesAt: string;
  isActive: boolean;
  sortOrder: number;
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

export interface CalendarCourt extends Pick<Court, 'id' | 'name' | 'sport' | 'slotMinutes' | 'opensAt' | 'closesAt'> {
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
