// jev-ax: finds and presses things on screen, through macOS Accessibility.
//
//   jev-ax click --text "YouTube"   press the link or button whose words match best
//   jev-ax click --nth 2            press the second search result on the page
//   jev-ax toggle --text Bluetooth --state off   set a switch or checkbox, and say what it is now
//   jev-ax page                     the address of the page in front, if a browser
//   jev-ax windows                  the windows showing on this desktop, and their apps
//   jev-ax media --key play|next|previous   press a media key, as the keyboard's own would
//   jev-ax tree | headings          what the window exposes, for diagnosing
//   jev-ax --version
//
// Add --dry-run to a click to find without pressing, and --pid <pid> to look
// at an app other than the one in front (for testing). Always prints one line of
// JSON: {"ok":true,"label":…,"role":…,"url":…} or {"ok":false,"error":…,"message":…}.
//
// It acts on the focused window of the app in front, as a person would. Web
// pages are searched with the same query VoiceOver's rotor uses
// (AXUIElementsForSearchPredicate), which WebKit and Chromium both answer in
// one round trip; native windows are walked directly, within a budget.
//
// Accessibility is granted to the app that runs this (JVA), not to this file.

import AppKit
import ApplicationServices
import Foundation

let version = "1"

// MARK: - Output

func emit(_ fields: [String: Any]) -> Never {
  let data = (try? JSONSerialization.data(withJSONObject: fields, options: [])) ?? Data("{}".utf8)
  FileHandle.standardOutput.write(data)
  FileHandle.standardOutput.write(Data("\n".utf8))
  exit(0)
}

func fail(_ code: String, _ message: String) -> Never {
  emit(["ok": false, "error": code, "message": message])
}

// MARK: - Accessibility helpers

func attribute(_ element: AXUIElement, _ name: String) -> AnyObject? {
  var value: AnyObject?
  guard AXUIElementCopyAttributeValue(element, name as CFString, &value) == .success else { return nil }
  return value
}

func text(_ element: AXUIElement, _ name: String) -> String {
  (attribute(element, name) as? String) ?? ""
}

func role(_ element: AXUIElement) -> String {
  text(element, kAXRoleAttribute as String)
}

func children(_ element: AXUIElement) -> [AXUIElement] {
  (attribute(element, kAXChildrenAttribute as String) as? [AXUIElement]) ?? []
}

func parent(_ element: AXUIElement) -> AXUIElement? {
  guard let value = attribute(element, kAXParentAttribute as String) else { return nil }
  return (value as! AXUIElement)
}

func url(_ element: AXUIElement) -> String? {
  if let u = attribute(element, "AXURL") as? URL { return u.absoluteString }
  if let s = attribute(element, "AXURL") as? String, !s.isEmpty { return s }
  return nil
}

/** The words on an element: its title, description or value, else the text inside it. */
func label(_ element: AXUIElement) -> String {
  for name in [kAXTitleAttribute as String, kAXDescriptionAttribute as String] {
    let s = text(element, name).trimmingCharacters(in: .whitespacesAndNewlines)
    if !s.isEmpty { return s }
  }
  if let v = attribute(element, kAXValueAttribute as String) as? String {
    let s = v.trimmingCharacters(in: .whitespacesAndNewlines)
    if !s.isEmpty { return s }
  }
  // Web links usually keep their words in the text inside them.
  return textInside(element, depth: 4)
}

func textInside(_ element: AXUIElement, depth: Int) -> String {
  guard depth > 0 else { return "" }
  var parts: [String] = []
  for child in children(element) {
    if role(child) == (kAXStaticTextRole as String) {
      if let v = attribute(child, kAXValueAttribute as String) as? String { parts.append(v) }
    } else {
      let t = text(child, kAXTitleAttribute as String)
      parts.append(t.isEmpty ? textInside(child, depth: depth - 1) : t)
    }
    if parts.joined().count > 300 { break }
  }
  return parts.map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
    .filter { !$0.isEmpty }
    .joined(separator: " ")
}

/** Width times height, for choosing the page among several web areas. */
func area(_ element: AXUIElement) -> Double {
  guard let value = attribute(element, kAXSizeAttribute as String) else { return 0 }
  var size = CGSize.zero
  AXValueGetValue(value as! AXValue, .cgSize, &size)
  return Double(size.width * size.height)
}

/**
 * The page in a browser window: its largest web area. Side panels are web
 * areas too, and an iframe is one nested inside the page, which the walk never
 * descends into.
 */
func webArea(in window: AXUIElement) -> AXUIElement? {
  var queue: [AXUIElement] = [window]
  var found: [AXUIElement] = []
  var visited = 0
  while !queue.isEmpty, visited < 5000, found.count < 4 {
    let element = queue.removeFirst()
    visited += 1
    if role(element) == "AXWebArea" {
      found.append(element)
      continue
    }
    queue.append(contentsOf: children(element))
  }
  return found.max { area($0) < area($1) }
}

/** VoiceOver's own search: elements of one kind, optionally matching words. */
func search(_ root: AXUIElement, key: String, words: String?, limit: Int) -> [AXUIElement] {
  var predicate: [String: Any] = [
    "AXSearchKey": key,
    "AXResultsLimit": limit,
    "AXDirection": "AXDirectionNext",
    "AXImmediateDescendantsOnly": false,
    "AXVisibleOnly": false,
  ]
  if let words = words, !words.isEmpty { predicate["AXSearchText"] = words }
  var result: AnyObject?
  let status = AXUIElementCopyParameterizedAttributeValue(
    root, "AXUIElementsForSearchPredicate" as CFString, predicate as CFDictionary, &result)
  guard status == .success, let found = result as? [AXUIElement] else { return [] }
  return found
}

/**
 * Everything pressable in a window, walked breadth first within a budget. Web
 * pages are skipped unless asked for: they are searched separately, and a big
 * one is far too big to walk.
 */
func pressables(in window: AXUIElement, budget: Int = 4000, intoWeb: Bool = false) -> [AXUIElement] {
  let kinds: Set<String> = [
    "AXButton", "AXLink", "AXMenuItem", "AXMenuButton", "AXPopUpButton", "AXCheckBox", "AXSwitch",
    "AXRadioButton", "AXTab", "AXDisclosureTriangle", "AXCell", "AXRow",
  ]
  var queue: [AXUIElement] = [window]
  var out: [AXUIElement] = []
  var visited = 0
  while !queue.isEmpty, visited < budget {
    let element = queue.removeFirst()
    visited += 1
    let r = role(element)
    if kinds.contains(r) { out.append(element) }
    if r == "AXWebArea" && !intoWeb { continue }
    queue.append(contentsOf: children(element))
  }
  return out
}

// MARK: - Matching

func normalized(_ s: String) -> String {
  let folded = s.folding(options: [.caseInsensitive, .diacriticInsensitive], locale: .current)
  let spaced = folded.unicodeScalars.map { CharacterSet.alphanumerics.contains($0) ? Character($0) : " " }
  return String(spaced).split(separator: " ").joined(separator: " ")
}

/** How well an element's words (or its link) match what was asked for; 0 is not at all. */
func score(label: String, link: String?, wanted: String) -> Int {
  let l = normalized(label)
  let w = normalized(wanted)
  guard !w.isEmpty else { return 0 }
  if l == w { return 100 }
  // "wifi" is "Wi‑Fi", "sign in" is "Sign-in": the same words, spaced differently.
  let squashedLabel = l.replacingOccurrences(of: " ", with: "")
  let squashedWanted = w.replacingOccurrences(of: " ", with: "")
  if squashedLabel == squashedWanted { return 95 }
  let words = Set(l.split(separator: " ").map(String.init))
  let asked = w.split(separator: " ").map(String.init)
  if l.hasPrefix(w + " ") { return 85 }
  if let link = link, let host = URL(string: link)?.host?.lowercased() {
    let bare = host.hasPrefix("www.") ? String(host.dropFirst(4)) : host
    let squashed = w.replacingOccurrences(of: " ", with: "")
    if bare == "\(squashed).com" || bare.hasPrefix("\(squashed).") { return 80 }
  }
  if asked.allSatisfy({ words.contains($0) }) { return 60 }
  if l.contains(w) { return 40 }
  return 0
}

// MARK: - Commands

func focusedWindow() -> (app: AXUIElement, window: AXUIElement, name: String) {
  guard AXIsProcessTrusted() else {
    fail("no-permission", "Accessibility permission is needed to click things on screen.")
  }
  let system = AXUIElementCreateSystemWide()
  var app: AXUIElement
  if let pid = targetPid {
    app = AXUIElementCreateApplication(pid)
  } else if let focused = attribute(system, kAXFocusedApplicationAttribute as String) {
    app = focused as! AXUIElement
  } else if let front = NSWorkspace.shared.frontmostApplication {
    app = AXUIElementCreateApplication(front.processIdentifier)
  } else {
    fail("no-window", "No app is in front.")
  }
  AXUIElementSetMessagingTimeout(app, 1.5)
  // Chromium builds its accessibility tree for web pages only on request.
  AXUIElementSetAttributeValue(app, "AXManualAccessibility" as CFString, kCFBooleanTrue)
  let name = text(app, kAXTitleAttribute as String)
  let window = attribute(app, targetPid == nil ? kAXFocusedWindowAttribute as String : kAXMainWindowAttribute as String)
    ?? attribute(app, kAXFocusedWindowAttribute as String)
    ?? attribute(app, kAXMainWindowAttribute as String)
  guard let found = window else { fail("no-window", "\(name.isEmpty ? "The app in front" : name) has no window open.") }
  return (app, found as! AXUIElement, name)
}

/**
 * The page's web area, waiting briefly for a browser that has just been asked
 * to build it. Chrome exposes web pages only once something asks the way
 * VoiceOver does — AXEnhancedUserInterface — so that is asked for when the
 * page is not there on its own. Electron apps answer to AXManualAccessibility.
 */
func page(in window: AXUIElement, app: AXUIElement) -> AXUIElement? {
  var found: AXUIElement? = nil
  for attempt in 0..<16 {
    if let web = webArea(in: window), !children(web).isEmpty {
      found = web
      break
    }
    if attempt == 1 {
      AXUIElementSetAttributeValue(app, "AXEnhancedUserInterface" as CFString, kCFBooleanTrue)
    }
    usleep(125_000)
  }
  guard let web = found else { return webArea(in: window) }
  // A page still loading has not got its links yet: "search for cats and
  // click the first result" asks for the click while the results arrive.
  for _ in 0..<32 {
    if (attribute(web, "AXLoaded") as? Bool) != false { break }
    usleep(125_000)
  }
  return web
}

/**
 * What to call it when saying what was clicked: a result link's own heading
 * ("YouTube"), not every word inside it ("YouTube YouTube https://…").
 */
func shortName(_ element: AXUIElement, _ label: String) -> String {
  for child in children(element) {
    if role(child) == "AXHeading" {
      let h = textInside(child, depth: 3)
      if !h.isEmpty { return h }
    }
    for grandchild in children(child) where role(grandchild) == "AXHeading" {
      let h = textInside(grandchild, depth: 3)
      if !h.isEmpty { return h }
    }
  }
  return label.count > 60 ? String(label.prefix(57)) + "…" : label
}

func press(_ element: AXUIElement, dryRun: Bool, label: String) -> Never {
  let r = role(element)
  var fields: [String: Any] = ["ok": true, "label": shortName(element, label), "role": r]
  if let u = url(element) { fields["url"] = u }
  if dryRun { emit(fields) }
  if AXUIElementPerformAction(element, kAXPressAction as CFString) == .success { emit(fields) }
  // A row in a list or a sidebar — System Settings' "Wi‑Fi" — is chosen by
  // selecting it, not pressing it.
  if r == "AXRow" || r == "AXCell" || r == "AXOutlineRow" {
    let target = r == "AXCell" ? (parent(element) ?? element) : element
    if AXUIElementSetAttributeValue(target, kAXSelectedAttribute as CFString, kCFBooleanTrue) == .success {
      emit(fields)
    }
  }
  // Last resort, a click in the middle of it — but only into the app in front:
  // a click at a screen position lands on whatever is on top there.
  var owner: pid_t = 0
  AXUIElementGetPid(element, &owner)
  guard owner == NSWorkspace.shared.frontmostApplication?.processIdentifier else {
    fail("not-pressable", "Found \"\(label)\", but it cannot be pressed while its app is behind another.")
  }
  _ = AXUIElementPerformAction(element, "AXScrollToVisible" as CFString)
  usleep(150_000)
  var origin = CGPoint.zero
  var size = CGSize.zero
  if let p = attribute(element, kAXPositionAttribute as String) { AXValueGetValue(p as! AXValue, .cgPoint, &origin) }
  if let s = attribute(element, kAXSizeAttribute as String) { AXValueGetValue(s as! AXValue, .cgSize, &size) }
  guard size.width > 0, size.height > 0 else { fail("not-pressable", "Found \"\(label)\", but it cannot be pressed.") }
  let point = CGPoint(x: origin.x + size.width / 2, y: origin.y + size.height / 2)
  for type in [CGEventType.leftMouseDown, .leftMouseUp] {
    CGEvent(mouseEventSource: nil, mouseType: type, mouseCursorPosition: point, mouseButton: .left)?.post(tap: .cghidEventTap)
    usleep(30_000)
  }
  emit(fields)
}

/**
 * The results on a search page, in order.
 *
 * A result is a heading tied to a link. Google and YouTube put the heading
 * inside the link (<a><h3>…</h3></a>); Bing and DuckDuckGo put the link inside
 * the heading (<h2><a>…</a></h2>). Google also has the second kind, for the
 * site links under a result — "Channel", "Library" — which are not results of
 * their own. So the first kind is used where a page has any, and the second
 * only where it has none.
 */
func results(on web: AXUIElement) -> [(link: AXUIElement, title: String)] {
  var outer: [(AXUIElement, String)] = []
  var inner: [(AXUIElement, String)] = []
  func add(_ link: AXUIElement, _ heading: AXUIElement, to list: inout [(AXUIElement, String)]) {
    if list.contains(where: { CFEqual($0.0, link) }) { return }
    let title = label(heading)
    list.append((link, title.isEmpty ? label(link) : title))
  }
  for heading in search(web, key: "AXHeadingSearchKey", words: nil, limit: 80) {
    var node = parent(heading)
    var enclosing: AXUIElement? = nil
    for _ in 0..<3 {
      guard let current = node else { break }
      if role(current) == "AXLink" { enclosing = current; break }
      node = parent(current)
    }
    if let link = enclosing {
      add(link, heading, to: &outer)
    } else if let link = search(heading, key: "AXLinkSearchKey", words: nil, limit: 1).first
      ?? children(heading).first(where: { role($0) == "AXLink" }) {
      add(link, heading, to: &inner)
    }
  }
  return outer.isEmpty ? inner : outer
}

func click(text wanted: String?, nth: Int?, dryRun: Bool) -> Never {
  let (app, window, appName) = focusedWindow()
  let web = page(in: window, app: app)

  if let n = nth {
    guard let web = web else { fail("not-found", "There are no search results in front.") }
    let found = results(on: web)
    guard n >= 1, n <= found.count else {
      fail("not-found", found.isEmpty ? "There are no search results in front." : "There are only \(found.count) results here.")
    }
    press(found[n - 1].link, dryRun: dryRun, label: found[n - 1].title)
  }

  guard let wanted = wanted, !normalized(wanted).isEmpty else { fail("usage", "Nothing to click was named.") }
  var best: (element: AXUIElement, label: String, score: Int)? = nil
  func consider(_ element: AXUIElement) {
    let l = label(element)
    let s = score(label: l, link: url(element), wanted: wanted)
    if s > 0, s > (best?.score ?? 0) { best = (element, l, s) }
  }

  if let web = web {
    // Words first, answered by the page itself; then every link and button,
    // scored here, for pages whose search matches less than it should.
    for key in ["AXLinkSearchKey", "AXButtonSearchKey"] {
      for element in search(web, key: key, words: wanted, limit: 40) { consider(element) }
    }
    if (best?.score ?? 0) < 100 {
      for key in ["AXLinkSearchKey", "AXButtonSearchKey"] {
        for element in search(web, key: key, words: nil, limit: 400) { consider(element) }
      }
    }
  }
  if (best?.score ?? 0) < 100 {
    for element in pressables(in: window) { consider(element) }
  }
  // Electron apps — Slack, Discord, VS Code, this app's own Settings — answer
  // the page search with nothing: walk their pages instead, which are small.
  if best == nil, web != nil {
    for element in pressables(in: window, budget: 6000, intoWeb: true) { consider(element) }
  }
  guard let chosen = best else {
    fail("not-found", "Couldn't find \"\(wanted)\" in \(appName.isEmpty ? "the window in front" : appName).")
  }
  press(chosen.element, dryRun: dryRun, label: chosen.label)
}

/**
 * The name of a switch. Settings panes often leave the switch itself unnamed
 * and put its name beside it — a row holding the text "Bluetooth" and a bare
 * switch — so the linked title, else the nearest text before it in its row,
 * names it.
 */
func switchLabel(_ element: AXUIElement) -> String {
  let own = label(element)
  if !own.isEmpty { return own }
  if let titled = attribute(element, kAXTitleUIElementAttribute as String) {
    let t = label(titled as! AXUIElement)
    if !t.isEmpty { return t }
  }
  guard let row = parent(element) else { return "" }
  var nearest = ""
  for sibling in children(row) {
    if CFEqual(sibling, element) { break }
    if role(sibling) == (kAXStaticTextRole as String), let v = attribute(sibling, kAXValueAttribute as String) as? String,
       !v.trimmingCharacters(in: .whitespaces).isEmpty {
      nearest = v
    }
  }
  return nearest
}

/** Whether a switch or checkbox is on: its value is 1 or 0. */
func isOn(_ element: AXUIElement) -> Bool? {
  (attribute(element, kAXValueAttribute as String) as? NSNumber).map { $0.intValue != 0 }
}

/**
 * Set a switch — System Settings' Bluetooth, say — to on or off, and report
 * what it is afterwards, read back rather than assumed: a switch macOS refuses
 * to flip, or flips only after a question of its own, must not be reported as
 * done. The window may still be drawing when asked, so it is looked for for a
 * few seconds.
 */
func toggle(text wanted: String?, on: Bool?, dryRun: Bool) -> Never {
  guard let wanted = wanted, !normalized(wanted).isEmpty else { fail("usage", "No switch was named.") }
  let (_, window, appName) = focusedWindow()
  var best: (element: AXUIElement, label: String, score: Int)? = nil
  for attempt in 0..<20 {
    best = nil
    for element in pressables(in: window) {
      let r = role(element)
      let sub = text(element, kAXSubroleAttribute as String)
      guard r == "AXCheckBox" || r == "AXSwitch" || sub == "AXSwitch", isOn(element) != nil else { continue }
      let l = switchLabel(element)
      let s = score(label: l, link: nil, wanted: wanted)
      if s > 0, s > (best?.score ?? 0) { best = (element, l, s) }
    }
    if best != nil { break }
    if attempt < 19 { usleep(150_000) }
  }
  guard let found = best, let before = isOn(found.element) else {
    fail("not-found", "Couldn't find a \"\(wanted)\" switch in \(appName.isEmpty ? "the window in front" : appName).")
  }
  var fields: [String: Any] = ["ok": true, "label": found.label, "role": role(found.element), "before": before]
  let target = on ?? !before
  if dryRun || before == target {
    fields["after"] = before
    emit(fields)
  }
  guard AXUIElementPerformAction(found.element, kAXPressAction as CFString) == .success else {
    fail("not-pressable", "Found the \(found.label) switch, but it cannot be pressed.")
  }
  var after = isOn(found.element) ?? before
  for _ in 0..<10 where after == before {
    usleep(150_000)
    after = isOn(found.element) ?? before
  }
  fields["after"] = after
  if after != target {
    fail("unchanged", "\(found.label) is still \(after ? "on" : "off") — macOS may be asking to confirm.")
  }
  emit(fields)
}

/**
 * The windows showing on this desktop, front to back, and the apps that own
 * them. A browser can be running with no window at all — Safari often is —
 * and "the browser" means the one you can see. Owners need no permission to
 * read; titles need Screen Recording, and are blank without it.
 */
func windowOwners() -> Never {
  let options = CGWindowListOption([.optionOnScreenOnly, .excludeDesktopElements])
  let list = (CGWindowListCopyWindowInfo(options, kCGNullWindowID) as? [[String: Any]]) ?? []
  var owners: [String] = []
  var windows: [[String: String]] = []
  for window in list {
    guard (window[kCGWindowLayer as String] as? Int) == 0,
          let bounds = window[kCGWindowBounds as String] as? [String: Any],
          ((bounds["Width"] as? Double) ?? 0) > 80, ((bounds["Height"] as? Double) ?? 0) > 80,
          let owner = window[kCGWindowOwnerName as String] as? String
    else { continue }
    if windows.count < 24 {
      windows.append(["app": owner, "title": (window[kCGWindowName as String] as? String) ?? ""])
    }
    if !owners.contains(owner) { owners.append(owner) }
  }
  emit(["ok": true, "apps": owners, "windows": windows])
}

/**
 * Press a media key — play/pause, next, previous — the way the keyboard's own
 * keys do, so it reaches whatever is playing: Music, Spotify, a video in a
 * browser. AppleScript cannot post these: they are system-defined events.
 */
func pressMediaKey(_ name: String, dryRun: Bool) -> Never {
  let keys: [String: Int32] = ["play": 16, "next": 17, "previous": 18] // NX_KEYTYPE_PLAY, _NEXT, _PREVIOUS
  guard let key = keys[name] else { fail("usage", "media --key play|next|previous") }
  if dryRun { emit(["ok": true, "key": name, "dryRun": true]) }
  for down in [true, false] {
    let flags = NSEvent.ModifierFlags(rawValue: down ? 0xa00 : 0xb00)
    let data1 = (Int(key) << 16) | ((down ? 0xa : 0xb) << 8)
    guard let event = NSEvent.otherEvent(with: .systemDefined, location: .zero, modifierFlags: flags,
                                         timestamp: ProcessInfo.processInfo.systemUptime, windowNumber: 0,
                                         context: nil, subtype: 8, data1: data1, data2: -1),
          let cg = event.cgEvent
    else { fail("event", "Could not make the key event.") }
    cg.post(tap: .cghidEventTap)
  }
  emit(["ok": true, "key": name])
}

/** Each heading on the page with its level and its ancestors: for tuning `results`. */
func headings() -> Never {
  let (app, window, _) = focusedWindow()
  guard let web = page(in: window, app: app) else { fail("not-found", "No page.") }
  var lines: [String] = []
  for heading in search(web, key: "AXHeadingSearchKey", words: nil, limit: 40) {
    var chain: [String] = []
    var node = parent(heading)
    for _ in 0..<10 {
      guard let current = node else { break }
      let r = role(current)
      let sub = text(current, kAXSubroleAttribute as String)
      chain.append(sub.isEmpty ? r : "\(r)/\(sub)")
      if r == "AXWebArea" { break }
      node = parent(current)
    }
    let level = (attribute(heading, kAXValueAttribute as String) as? NSNumber)?.intValue ?? -1
    lines.append("h\(level) \(label(heading).prefix(40)) <- \(chain.joined(separator: " < "))")
  }
  emit(["ok": true, "headings": lines.joined(separator: "\n")])
}

/** The window's tree, a few levels deep: for diagnosing an app that exposes little. */
func tree(depth maxDepth: Int) -> Never {
  let (_, window, appName) = focusedWindow()
  var lines: [String] = ["\(appName)"]
  func walk(_ element: AXUIElement, _ depth: Int) {
    guard depth <= maxDepth, lines.count < 400 else { return }
    let l = label(element).prefix(60)
    lines.append(String(repeating: "  ", count: depth) + "\(role(element)) \(l)")
    for child in children(element) { walk(child, depth + 1) }
  }
  walk(window, 0)
  emit(["ok": true, "tree": lines.joined(separator: "\n")])
}

func currentPage() -> Never {
  let (app, window, appName) = focusedWindow()
  guard let web = page(in: window, app: app) else { fail("not-found", "\(appName) is not showing a web page.") }
  emit(["ok": true, "label": label(web), "role": "AXWebArea", "url": url(web) ?? "", "app": appName])
}

// MARK: - Main

var args = Array(CommandLine.arguments.dropFirst())
let dryRun = args.contains("--dry-run")
args.removeAll { $0 == "--dry-run" }

func option(_ name: String) -> String? {
  guard let i = args.firstIndex(of: name), i + 1 < args.count else { return nil }
  return args[i + 1]
}

let targetPid: pid_t? = option("--pid").flatMap { pid_t($0) }

switch args.first {
case "--version":
  emit(["ok": true, "version": version])
case "click":
  let nth = option("--nth").flatMap { Int($0) }
  click(text: option("--text"), nth: nth, dryRun: dryRun)
case "toggle":
  let state = option("--state")
  toggle(text: option("--text"), on: state == "on" ? true : state == "off" ? false : nil, dryRun: dryRun)
case "page":
  currentPage()
case "headings":
  headings()
case "windows":
  windowOwners()
case "media":
  pressMediaKey(option("--key") ?? "", dryRun: dryRun)
case "tree":
  tree(depth: option("--depth").flatMap { Int($0) } ?? 6)
default:
  fail("usage", "usage: jev-ax click --text <words> | --nth <n> [--dry-run]; jev-ax page; jev-ax --version")
}
