// WebSocket client for /ws (same origin; Vite proxies it in dev). Reconnects with capped backoff.
import type { IncidentEvent, ServerMessage } from '@healops/shared/types';

export interface WsHandlers {
  onOpen(): void;
  onHello(msg: Extract<ServerMessage, { kind: 'hello' }>): void;
  onEvent(event: IncidentEvent): void;
  onClose(): void;
}

export function connectWs(handlers: WsHandlers): { close(): void } {
  const scheme = window.location.protocol === 'https:' ? 'wss' : 'ws';
  const url = `${scheme}://${window.location.host}/ws`;
  let socket: WebSocket | undefined;
  let retries = 0;
  let timer = 0;
  let stopped = false;

  const open = (): void => {
    socket = new WebSocket(url);
    socket.onopen = () => {
      retries = 0;
      handlers.onOpen();
    };
    socket.onmessage = (ev: MessageEvent) => {
      let msg: ServerMessage | undefined;
      try {
        msg = JSON.parse(String(ev.data)) as ServerMessage;
      } catch {
        return;
      }
      if (!msg || typeof msg !== 'object') return;
      if (msg.kind === 'hello') handlers.onHello(msg);
      else if (msg.kind === 'event' && msg.event) handlers.onEvent(msg.event);
    };
    socket.onclose = () => {
      socket = undefined;
      if (stopped) return;
      handlers.onClose();
      retries++;
      timer = window.setTimeout(open, Math.min(5000, 400 * 2 ** Math.min(retries, 4)));
    };
  };

  open();
  return {
    close() {
      stopped = true;
      window.clearTimeout(timer);
      socket?.close();
    },
  };
}
