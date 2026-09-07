import { NavLink, Navigate, Route, Routes } from 'react-router-dom';
import { useAuth } from './lib/auth';
import { VenueProvider, VenueSwitcher } from './lib/venue';
import { LoginPage } from './pages/LoginPage';
import { AcceptInvitePage } from './pages/AcceptInvitePage';
import { CalendarPage } from './pages/CalendarPage';
import { BookingsPage } from './pages/BookingsPage';
import { CustomersPage } from './pages/CustomersPage';
import { SeriesPage } from './pages/SeriesPage';
import { ActivityPage } from './pages/ActivityPage';
import { PublicVenuePage } from './public/PublicVenuePage';
import { SettingsPage } from './pages/SettingsPage';
import { ReportsPage } from './pages/ReportsPage';

export default function App() {
  const { me, loading, logout } = useAuth();
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
        <nav className="nav">
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
