import { useEffect, useRef } from 'react';
import { useAuth } from '../stores/authStore';

export interface MDMEvent { subject: string; data: unknown }

// useEventStream opens a WebSocket to the notification-service. Auth is sent
// via the Sec-WebSocket-Protocol header (only mechanism browsers expose for
// custom auth on WS connections without HTTP-only cookies).
export function useEventStream(onEvent: (e: MDMEvent) => void) {
  const token = useAuth(s => s.accessToken);
  const ref = useRef<WebSocket | null>(null);

  useEffect(() => {
    if (!token) return;
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const url = `${protocol}//${location.host}/ws`;
    const ws = new WebSocket(url, ['Bearer', token]);
    ref.current = ws;
    ws.onmessage = ev => {
      try { onEvent(JSON.parse(ev.data)); } catch { /* ignore */ }
    };
    return () => ws.close();
  }, [token, onEvent]);
}
