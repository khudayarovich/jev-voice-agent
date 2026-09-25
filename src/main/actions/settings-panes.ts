/**
 * Pages of System Settings, and the words people use for them.
 *
 * "open Bluetooth settings" should land on the Bluetooth page, not on the front
 * page of System Settings with the user left to find it. Each page opens by the
 * identifier of its settings extension (x-apple.systempreferences:<id>); these
 * are the ids macOS 26 ships.
 */

export interface SettingsPane {
  /** What the model chooses between, and what the HUD shows. */
  label: string;
  id: string;
  /** Words that point at this page, matched as whole words. */
  words: string[];
}

export const SETTINGS_PANES: SettingsPane[] = [
  { label: "Wi-Fi", id: "com.apple.wifi-settings-extension", words: ["wifi", "wi fi", "wireless", "hotspot"] },
  { label: "Bluetooth", id: "com.apple.BluetoothSettings", words: ["bluetooth", "airpods", "pair"] },
  { label: "Network", id: "com.apple.Network-Settings.extension", words: ["network", "ethernet", "internet", "dns", "proxy", "firewall"] },
  { label: "VPN", id: "com.apple.NetworkExtensionSettingsUI.NESettingsUIExtension", words: ["vpn"] },
  { label: "Displays", id: "com.apple.Displays-Settings.extension", words: ["display", "displays", "screen", "monitor", "resolution", "brightness", "night shift", "true tone", "external screen", "screen resolution"] },
  { label: "Sound", id: "com.apple.Sound-Settings.extension", words: ["sound", "audio", "speaker", "speakers", "microphone", "mic", "output", "input", "alert sound"] },
  { label: "Battery", id: "com.apple.Battery-Settings.extension", words: ["battery", "power", "energy", "low power", "charging"] },
  { label: "Notifications", id: "com.apple.Notifications-Settings.extension", words: ["notification", "notifications", "alerts"] },
  { label: "Focus", id: "com.apple.Focus-Settings.extension", words: ["focus", "do not disturb"] },
  { label: "Screen Time", id: "com.apple.Screen-Time-Settings.extension", words: ["screen time", "parental", "app limits"] },
  { label: "Privacy & Security", id: "com.apple.settings.PrivacySecurity.extension", words: ["privacy", "security", "permission", "permissions", "camera access", "microphone access", "location", "filevault", "accessibility access"] },
  { label: "Accessibility", id: "com.apple.Accessibility-Settings.extension", words: ["accessibility", "voiceover", "voice over", "zoom", "reduce motion", "larger text"] },
  { label: "Appearance", id: "com.apple.Appearance-Settings.extension", words: ["appearance", "dark mode", "light mode", "accent colour", "accent color", "theme", "highlight colour", "highlight color"] },
  { label: "Wallpaper", id: "com.apple.Wallpaper-Settings.extension", words: ["wallpaper", "background", "desktop picture", "screen saver", "screensaver"] },
  { label: "Desktop & Dock", id: "com.apple.Desktop-Settings.extension", words: ["dock", "desktop", "hot corners", "stage manager", "mission control", "widgets", "default browser", "window tiling"] },
  { label: "Control Center", id: "com.apple.ControlCenter-Settings.extension", words: ["control center", "control centre", "menu bar"] },
  { label: "Siri", id: "com.apple.Siri-Settings.extension", words: ["siri", "apple intelligence"] },
  { label: "Spotlight", id: "com.apple.Spotlight-Settings.extension", words: ["spotlight", "search results"] },
  { label: "Lock Screen", id: "com.apple.Lock-Screen-Settings.extension", words: ["lock screen", "screen lock", "require password", "turn display off"] },
  { label: "Touch ID & Password", id: "com.apple.Touch-ID-Settings.extension", words: ["touch id", "fingerprint", "password", "login password"] },
  { label: "Users & Groups", id: "com.apple.Users-Groups-Settings.extension", words: ["users", "groups", "user account", "accounts", "guest"] },
  { label: "Internet Accounts", id: "com.apple.Internet-Accounts-Settings.extension", words: ["internet accounts", "email accounts", "mail accounts", "google account"] },
  { label: "Apple Account", id: "com.apple.systempreferences.AppleIDSettings", words: ["apple id", "apple account", "icloud"] },
  { label: "Family", id: "com.apple.Family-Settings.extension", words: ["family", "family sharing"] },
  { label: "Wallet & Apple Pay", id: "com.apple.WalletSettingsExtension", words: ["wallet", "apple pay"] },
  { label: "Game Center", id: "com.apple.Game-Center-Settings.extension", words: ["game center", "game centre"] },
  { label: "Game Controllers", id: "com.apple.Game-Controller-Settings.extension", words: ["game controller", "controller", "gamepad", "joystick"] },
  { label: "Keyboard", id: "com.apple.Keyboard-Settings.extension", words: ["keyboard", "shortcuts", "keyboard shortcuts", "input sources", "dictation", "key repeat"] },
  { label: "Trackpad", id: "com.apple.Trackpad-Settings.extension", words: ["trackpad", "gestures", "tap to click", "touchpad"] },
  { label: "Mouse", id: "com.apple.Mouse-Settings.extension", words: ["mouse", "scroll direction", "pointer speed"] },
  { label: "Printers & Scanners", id: "com.apple.Print-Scan-Settings.extension", words: ["printer", "printers", "scanner", "scanners", "printing"] },
  { label: "Headphones", id: "com.apple.HeadphoneSettings", words: ["headphones", "headphone"] },
  { label: "Software Update", id: "com.apple.Software-Update-Settings.extension", words: ["update", "updates", "software update", "upgrade macos", "macos update"] },
  { label: "Storage", id: "com.apple.settings.Storage", words: ["storage", "disk space", "free space", "space left"] },
  { label: "About", id: "com.apple.SystemProfiler.AboutExtension", words: ["about", "about this mac", "serial number", "macos version", "specs", "model"] },
  { label: "AirDrop & Handoff", id: "com.apple.AirDrop-Handoff-Settings.extension", words: ["airdrop", "air drop", "handoff", "airplay receiver"] },
  { label: "Sharing", id: "com.apple.Sharing-Settings.extension", words: ["sharing", "screen sharing", "file sharing", "remote login", "computer name"] },
  { label: "Login Items", id: "com.apple.LoginItems-Settings.extension", words: ["login items", "startup apps", "open at login", "launch at login", "background items"] },
  { label: "Date & Time", id: "com.apple.Date-Time-Settings.extension", words: ["date", "time", "time zone", "timezone", "clock"] },
  { label: "Language & Region", id: "com.apple.Localization-Settings.extension", words: ["language", "languages", "region", "locale", "date format"] },
  { label: "Time Machine", id: "com.apple.Time-Machine-Settings.extension", words: ["time machine", "backup", "backups"] },
  { label: "Startup Disk", id: "com.apple.Startup-Disk-Settings.extension", words: ["startup disk", "boot disk"] },
  { label: "Transfer or Reset", id: "com.apple.Transfer-Reset-Settings.extension", words: ["reset", "erase", "factory reset", "transfer"] },
  { label: "Device Management", id: "com.apple.Profiles-Settings.extension", words: ["profiles", "device management", "mdm"] },
];

/**
 * No page in particular: System Settings as it opens. "open settings" names no
 * page, and asking which one was the wrong answer to it.
 */
export const SETTINGS_HOME = "System Settings";

const byLabel = new Map(SETTINGS_PANES.map((p) => [p.label, p]));

export function paneByLabel(label: string): SettingsPane | undefined {
  return byLabel.get(label);
}

const norm = (s: string) =>
  ` ${s.toLowerCase().replace(/[-_]/g, " ").replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim()} `;

const bare = (s: string) => norm(s).replace(/ and /g, " ").trim();

/**
 * The page these words name, and nothing more: "battery" is Battery, "wi-fi"
 * is Wi-Fi, "privacy and security" is Privacy & Security. "battery life" is
 * not a page: that is for the model to read.
 */
export function paneNamed(words: string): string | undefined {
  const w = bare(words);
  return SETTINGS_PANES.find((p) => bare(p.label) === w || p.words.some((x) => bare(x) === w))?.label;
}

/**
 * The pages a request mentions, best first: the page with the longest matching
 * phrase wins, so "screen time" beats "time" and "dark mode" beats nothing.
 */
export function shortlistPanes(transcript: string): string[] {
  const t = norm(transcript);
  return SETTINGS_PANES.map((p) => ({
    label: p.label,
    score: Math.max(0, ...p.words.filter((w) => t.includes(norm(w))).map((w) => w.length)),
  }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .map((x) => x.label);
}
