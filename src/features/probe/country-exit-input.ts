export type CountryExitInput = {
  country: string;
  endpoint: {
    enabled: boolean;
    scheme: string;
    host: string;
    port: number;
    username: string;
    password: string;
    label: string;
  };
};

export function parseCountryExitText(raw: string): CountryExitInput[] {
  const rows: CountryExitInput[] = [];
  raw.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).forEach((line) => {
    const [countryPart, endpointPart] = line.split('----').map((part) => part.trim());
    const country = String(countryPart || '').toUpperCase();
    if (!/^[A-Z]{2}$/.test(country) || !endpointPart) return;
    let scheme = 'http';
    let host = '';
    let port = 0;
    let username = '';
    let password = '';
    try {
      const normalized = endpointPart.includes('://') ? endpointPart : `http://${endpointPart}`;
      const url = new URL(normalized);
      scheme = (url.protocol.replace(':', '') || 'http').toLowerCase();
      host = url.hostname;
      port = Number(url.port || 0);
      username = decodeURIComponent(url.username || '');
      password = decodeURIComponent(url.password || '');
    } catch {
      const match = endpointPart.match(/^(?:(https?|socks5|socks4):\/\/)?(?:([^:@]+):([^@]*)@)?([^:]+):(\d+)$/i);
      if (!match) return;
      scheme = (match[1] || 'http').toLowerCase();
      username = match[2] || '';
      password = match[3] || '';
      host = match[4] || '';
      port = Number(match[5] || 0);
    }
    if (!host || port <= 0) return;
    rows.push({ country, endpoint: { enabled: true, scheme, host, port, username, password, label: `出口/${country}` } });
  });
  return rows;
}
