import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { get, getToken, post, setToken } from './api';

interface Me {
  id: string;
  email: string;
  name: string;
  role: 'owner' | 'staff';
  tenant: { id: string; name: string };
}

interface AuthValue {
  me: Me | null;
  loading: boolean;
  login: (email: string, password: string) => Promise<void>;
  register: (input: { businessName: string; name: string; email: string; password: string }) => Promise<void>;
  logout: () => void;
}

const AuthContext = createContext<AuthValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [me, setMe] = useState<Me | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!getToken()) {
      setLoading(false);
      return;
    }
    get<Me>('/auth/me')
      .then(setMe)
      .catch(() => setToken(null))
      .finally(() => setLoading(false));
  }, []);

  const login = useCallback(async (email: string, password: string) => {
    const res = await post<{ token: string }>('/auth/login', { email, password });
    setToken(res.token);
    setMe(await get<Me>('/auth/me'));
  }, []);

  const register = useCallback(
    async (input: { businessName: string; name: string; email: string; password: string }) => {
      const res = await post<{ token: string }>('/auth/register', input);
      setToken(res.token);
      setMe(await get<Me>('/auth/me'));
    },
    [],
  );

  const logout = useCallback(() => {
    setToken(null);
    setMe(null);
    location.assign('/login');
  }, []);

  const value = useMemo(() => ({ me, loading, login, register, logout }), [me, loading, login, register, logout]);
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside AuthProvider');
  return ctx;
}
