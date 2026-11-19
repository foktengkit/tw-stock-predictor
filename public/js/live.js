/** WebSocket 即時報價：自動重連，重連後重新訂閱 */
export class Live {
  constructor({ onQuotes, onCalendar, onOfficial, onConnection }) {
    this.onQuotes = onQuotes;
    this.onCalendar = onCalendar;
    this.onOfficial = onOfficial;
    this.onConnection = onConnection;
    this.codes = [];
    this.retry = 0;
    this.connect();
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible' && (!this.ws || this.ws.readyState > 1)) this.connect();
    });
  }

  connect() {
    clearTimeout(this.timer);
    const url = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`;
    const ws = new WebSocket(url);
    this.ws = ws;
    ws.onopen = () => { this.retry = 0; this.onConnection(true); this.send(); };
    ws.onmessage = (e) => {
      try {
        const msg = JSON.parse(e.data);
        if (msg.type === 'quotes') this.onQuotes(msg);
        else if (msg.type === 'calendar' && this.onCalendar) this.onCalendar(msg);
        else if (msg.type === 'official' && this.onOfficial) this.onOfficial(msg);
      } catch { /* ignore */ }
    };
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.onConnection(false);
      const delay = Math.min(15000, 1000 * 2 ** this.retry++);
      this.timer = setTimeout(() => this.connect(), delay);
    };
    ws.onerror = () => ws.close();
  }

  subscribe(codes) {
    this.codes = [...new Set(codes.filter(Boolean))];
    this.send();
  }

  send() {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ type: 'subscribe', codes: this.codes }));
  }
}
