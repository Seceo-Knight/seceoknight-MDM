import axios, { AxiosError, AxiosRequestConfig } from 'axios';
import { useAuth } from '../stores/authStore';

export const api = axios.create({ baseURL: '/' });

api.interceptors.request.use(cfg => {
  const t = useAuth.getState().accessToken;
  if (t) cfg.headers.Authorization = `Bearer ${t}`;
  return cfg;
});

let refreshing: Promise<string | null> | null = null;

api.interceptors.response.use(
  r => r,
  async (err: AxiosError) => {
    const original = err.config as (AxiosRequestConfig & { _retry?: boolean }) | undefined;
    if (err.response?.status !== 401 || !original || original._retry) {
      return Promise.reject(err);
    }
    original._retry = true;
    refreshing ??= refreshAccessToken().finally(() => { refreshing = null; });
    const newToken = await refreshing;
    if (!newToken) {
      useAuth.getState().logout();
      return Promise.reject(err);
    }
    original.headers = { ...(original.headers || {}), Authorization: `Bearer ${newToken}` };
    return api.request(original);
  }
);

async function refreshAccessToken(): Promise<string | null> {
  const { refreshToken, setTokens } = useAuth.getState();
  if (!refreshToken) return null;
  try {
    const r = await axios.post('/api/v1/auth/refresh', { refresh_token: refreshToken });
    setTokens(r.data.access_token, r.data.refresh_token);
    return r.data.access_token;
  } catch {
    return null;
  }
}
