import { useState } from 'react';
import { useAuth } from '../lib/auth';
import { ApiError } from '../lib/api';

export function LoginPage() {
  const { login, register } = useAuth();
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [businessName, setBusinessName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      if (mode === 'login') await login(email, password);
      else await register({ businessName, name, email, password });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Something went wrong.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="center-page">
      <div className="card">
        <div className="card-head">
          <div className="brand">
            Booking<span>Master</span>
          </div>
        </div>
        <form className="card-body" onSubmit={submit}>
          <h1 style={{ marginBottom: 4 }}>{mode === 'login' ? 'Sign in' : 'Create your account'}</h1>
          <p className="faint" style={{ marginTop: 0, marginBottom: 18, fontSize: 13 }}>
            {mode === 'login'
              ? 'Your courts, your calendar.'
              : 'Set up your business, then add your venue and courts.'}
          </p>

          {error && <div className="msg error">{error}</div>}

          {mode === 'register' && (
            <>
              <div className="field">
                <label htmlFor="businessName">Business name</label>
                <input
                  id="businessName"
                  value={businessName}
                  onChange={(e) => setBusinessName(e.target.value)}
                  placeholder="Smash Arena"
                  required
                />
              </div>
              <div className="field">
                <label htmlFor="name">Your name</label>
                <input id="name" value={name} onChange={(e) => setName(e.target.value)} required />
              </div>
            </>
          )}

          <div className="field">
            <label htmlFor="email">Email</label>
            <input
              id="email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              autoComplete="username"
              required
            />
          </div>
          <div className="field">
            <label htmlFor="password">Password</label>
            <input
              id="password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
              minLength={mode === 'register' ? 8 : undefined}
              required
            />
            {mode === 'register' && <div className="hint">At least 8 characters.</div>}
          </div>

          <button className="primary" type="submit" disabled={busy} style={{ width: '100%', padding: 9 }}>
            {busy ? 'Please wait…' : mode === 'login' ? 'Sign in' : 'Create account'}
          </button>

          <div style={{ marginTop: 14, textAlign: 'center' }}>
            <button
              type="button"
              className="ghost sm"
              onClick={() => {
                setMode(mode === 'login' ? 'register' : 'login');
                setError(null);
              }}
            >
              {mode === 'login' ? 'Need an account? Sign up' : 'Already have an account? Sign in'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
