import { create } from 'zustand';
import { persist } from 'zustand/middleware';

interface AuthUser {
  id: string;
  email: string;
  role: string;
  tenant_id: string;
  permissions?: string[];
}

interface AuthState {
  accessToken: string | null;
  refreshToken: string | null;
  user: AuthUser | null;
  dark: boolean;
  setTokens: (a: string, r: string) => void;
  setUser: (u: AuthUser | null) => void;
  toggleDark: () => void;
  logout: () => void;
}

export const useAuth = create<AuthState>()(
  persist(
    (set, get) => ({
      accessToken: null,
      refreshToken: null,
      user: null,
      dark: true,
      setTokens: (accessToken, refreshToken) => set({ accessToken, refreshToken }),
      setUser: user => set({ user }),
      toggleDark: () => set(s => ({ dark: !s.dark })),
      logout: () => {
        // Revoke the session SERVER-SIDE so it actually ends — otherwise the
        // refresh token stays valid and the session keeps showing as "active"
        // in the Access Log. /auth/logout is unauthenticated and takes the
        // refresh token directly; fire-and-forget with keepalive so it survives
        // the immediate redirect to /login. Local state is cleared regardless,
        // so the user is always logged out client-side even if the call fails.
        const rt = get().refreshToken;
        if (rt) {
          fetch('/api/v1/auth/logout', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ refresh_token: rt }),
            keepalive: true,
          }).catch(() => {});
        }
        set({ accessToken: null, refreshToken: null, user: null });
      },
    }),
    { name: 'mdm-auth' }
  )
);
