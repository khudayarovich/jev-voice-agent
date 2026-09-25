/**
 * Which network interface is the Wi‑Fi, from `networksetup -listallhardwareports`:
 *
 *   Hardware Port: Wi-Fi
 *   Device: en0
 *
 * Usually en0, but not on every Mac, and never assumed.
 */
export function wifiDevice(listing: string): string | null {
  const lines = listing.split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (/^Hardware Port:\s*(Wi-?Fi|AirPort)\s*$/i.test(lines[i]!.trim())) {
      const device = lines[i + 1]?.match(/^Device:\s*(\S+)/)?.[1];
      if (device) return device;
    }
  }
  return null;
}
