import { NavLink, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { useEffect, useRef } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useAuth } from './lib/auth';
import { get } from './lib/api';
import { VenueProvider, VenueSwitcher, useVenue } from './lib/venue';
import type { Court } from './lib/types';
import { LoginPage } from './pages/LoginPage';
import { AcceptInvitePage } from './pages/AcceptInvitePage';
import { CalendarPage } from './pages/CalendarPage';
import { BookingsPage } from './pages/BookingsPage';
import { CustomersPage } from './pages/CustomersPage';
import { SeriesPage } from './pages/SeriesPage';
import { ActivityPage } from './pages/ActivityPage';
import { PublicVenuePage } from './public/PublicVenuePage';
import { SettingsPage } from './pages/SettingsPage';
import { HallsPage } from './pages/HallsPage';
import { ReportsPage } from './pages/ReportsPage';

/**
 * Keeps the current page's tab visible in the nav.
 *
 * On a phone the nav is a scrolling strip that cannot show all seven at once,
 * so after navigating — or on a cold load of a deep link — the tab you are on
 * can sit off-screen, and the strip reads as though nothing is selected.
 */
function useNavFollowsRoute() {
  const nav = useRef<HTMLElement>(null);
  const { pathname } = useLocation();

  useEffect(() => {
    const active = nav.current?.querySelector('a.active');
    active?.scrollIntoView({ inline: 'nearest', block: 'nearest', behavior: 'smooth' });
  }, [pathname]);

  return nav;
}

export default function App() {
  const { me, loading, logout } = useAuth();
  const navRef = useNavFollowsRoute();
  const isPublic = location.pathname.startsWith('/v/');

  // Taking up an invitation happens before there is an account to gate on.
  if (location.pathname === '/invite') {
    return (
      <Routes>
        <Route path="/invite" element={<AcceptInvitePage />} />
      </Routes>
    );
  }

  // The public booking page has no account behind it, so it renders before the
  // auth gate rather than inside it.
  if (isPublic) {
    return (
      <Routes>
        <Route path="/v/:slug" element={<PublicVenuePage />} />
      </Routes>
    );
  }

  if (loading) {
    return (
      <div className="center-page">
        <span className="faint">Loading…</span>
      </div>
    );
  }

  if (!me) {
    return (
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route path="*" element={<Navigate to="/login" replace />} />
      </Routes>
    );
  }

  const isOwner = me.role === 'owner';

  return (
    <VenueProvider>
    <div className="shell">
      <header className="topbar">
        <div className="brand">
          Booking<span>Master</span>
        </div>
        <nav className="nav" ref={navRef}>
          <NavLink to="/calendar" className={({ isActive }) => (isActive ? 'active' : '')}>
            Calendar
          </NavLink>
          <NavLink to="/bookings" className={({ isActive }) => (isActive ? 'active' : '')}>
            Bookings
          </NavLink>
          <NavLink to="/series" className={({ isActive }) => (isActive ? 'active' : '')}>
            Recurring
          </NavLink>
          <NavLink to="/customers" className={({ isActive }) => (isActive ? 'active' : '')}>
            Customers
          </NavLink>
          <HallsNavLink />
          {isOwner && (
            <>
              <NavLink to="/reports" className={({ isActive }) => (isActive ? 'active' : '')}>
                Reports
              </NavLink>
              <NavLink to="/activity" className={({ isActive }) => (isActive ? 'active' : '')}>
                Activity
              </NavLink>
            </>
          )}
          <NavLink to="/settings" className={({ isActive }) => (isActive ? 'active' : '')}>
            Settings
          </NavLink>
        </nav>
        <div className="topbar-right">
          <VenueSwitcher />
          <span className="who">
            {me.tenant.name}
            <span className="faint"> · {me.name}</span>
          </span>
          <button className="ghost sm" onClick={logout}>
            Sign out
          </button>
        </div>
      </header>

      <main className="page">
        <Routes>
          <Route path="/calendar" element={<CalendarPage />} />
          <Route path="/bookings" element={<BookingsPage />} />
          <Route path="/series" element={<SeriesPage />} />
          <Route path="/customers" element={<CustomersPage />} />
          <Route path="/halls" element={<HallsPage />} />
          {/* Hidden from staff in the nav, and refused by the server either way —
              this stops a typed URL rendering a page that can only error. */}
          {isOwner && <Route path="/reports" element={<ReportsPage />} />}
          {isOwner && <Route path="/activity" element={<ActivityPage />} />}
          <Route path="/settings" element={<SettingsPage />} />
          <Route path="*" element={<Navigate to="/calendar" replace />} />
        </Routes>
      </main>
    </div>
    </VenueProvider>
  );
}

/**
 * The Halls tab, shown only to venues that have a hall.
 *
 * Most venues are courts and nothing else, and a permanently empty tab is worse
 * than no tab. The route itself stays registered either way — the page explains
 * how to add a hall rather than bouncing a typed URL somewhere else.
 */
function HallsNavLink() {
  const { venue } = useVenue();
  const { data: halls } = useQuery({
    queryKey: ['halls', venue?.id],
    queryFn: () => get<Court[]>(`/venues/${venue!.id}/resources?kind=hall`),
    enabled: !!venue,
  });

  if (!halls?.length) return null;
  return (
    <NavLink to="/halls" className={({ isActive }) => (isActive ? 'active' : '')}>
      Halls
    </NavLink>
  );
}
