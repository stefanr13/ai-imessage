import AppKit
import ApplicationServices
import Foundation

let messagesBundleId = "com.apple.MobileSMS"

struct AXNode: Codable {
    var path: String
    var role: String?
    var subrole: String?
    var title: String?
    var description: String?
    var value: String?
    var help: String?
    var identifier: String?
    var focused: Bool?
    var selected: Bool?
    var actions: [String]
    var children: [AXNode]
}

struct VisibleMessage: Codable {
    var direction: String
    var sender: String?
    var text: String
    var rawDescription: String?
    var frame: RectInfo?
    var parentFrame: RectInfo?
}

struct ReadVisibleResult: Codable {
    var ok: Bool
    var trusted: Bool
    var conversationTitle: String?
    var messages: [VisibleMessage]
}

struct BasicResult: Codable {
    var ok: Bool
    var trusted: Bool
    var message: String?
}

struct ConversationListItem: Codable {
    var description: String?
    var selected: Bool?
    var frame: RectInfo?
    var staticTexts: [String]
}

struct ConversationListResult: Codable {
    var ok: Bool
    var trusted: Bool
    var items: [ConversationListItem]
}

struct ConversationIdentityResult: Codable {
    var ok: Bool
    var trusted: Bool
    var conversationTitle: String?
    var names: [String]
    var phoneNumbers: [String]
    var emails: [String]
    var uiTitles: [String]
    var rawTexts: [String]
    var message: String?
}

struct SidebarOpenTarget {
    var element: AXUIElement
    var path: [AXUIElement]
}

struct RectInfo: Codable {
    var x: Double
    var y: Double
    var width: Double
    var height: Double
}

func printJSON<T: Encodable>(_ value: T) {
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
    do {
        let data = try encoder.encode(value)
        FileHandle.standardOutput.write(data)
        FileHandle.standardOutput.write("\n".data(using: .utf8)!)
    } catch {
        fputs("JSON encode error: \(error)\n", stderr)
        exit(1)
    }
}

func isTrusted(prompt: Bool = false) -> Bool {
    if prompt {
        let options = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary
        return AXIsProcessTrustedWithOptions(options)
    }
    return AXIsProcessTrusted()
}

func attr(_ element: AXUIElement, _ name: String) -> AnyObject? {
    var value: AnyObject?
    let result = AXUIElementCopyAttributeValue(element, name as CFString, &value)
    return result == .success ? value : nil
}

func attrString(_ element: AXUIElement, _ name: String) -> String? {
    guard let value = attr(element, name) else { return nil }
    if let string = value as? String { return string }
    if CFGetTypeID(value) == AXValueGetTypeID() { return nil }
    return "\(value)"
}

func attrBool(_ element: AXUIElement, _ name: String) -> Bool? {
    guard let value = attr(element, name) else { return nil }
    if let bool = value as? Bool { return bool }
    return nil
}

func attrRect(_ element: AXUIElement, _ name: String) -> CGRect? {
    guard let value = attr(element, name),
          CFGetTypeID(value) == AXValueGetTypeID() else {
        return nil
    }
    let axValue = value as! AXValue
    guard AXValueGetType(axValue) == .cgRect else { return nil }
    var rect = CGRect.zero
    guard AXValueGetValue(axValue, .cgRect, &rect) else { return nil }
    return rect
}

func rectInfo(_ rect: CGRect?) -> RectInfo? {
    guard let rect else { return nil }
    return RectInfo(
        x: Double(rect.origin.x),
        y: Double(rect.origin.y),
        width: Double(rect.size.width),
        height: Double(rect.size.height)
    )
}

func children(_ element: AXUIElement) -> [AXUIElement] {
    guard let raw = attr(element, kAXChildrenAttribute) else { return [] }
    return raw as? [AXUIElement] ?? []
}

func actions(_ element: AXUIElement) -> [String] {
    var raw: CFArray?
    let result = AXUIElementCopyActionNames(element, &raw)
    guard result == .success, let raw else { return [] }
    return raw as? [String] ?? []
}

func appElement(launchIfNeeded: Bool = true, activate: Bool = true) -> (NSRunningApplication, AXUIElement)? {
    if let app = NSRunningApplication.runningApplications(withBundleIdentifier: messagesBundleId).first {
        if activate {
            app.activate(options: [.activateAllWindows, .activateIgnoringOtherApps])
            usleep(250_000)
        }
        return (app, AXUIElementCreateApplication(app.processIdentifier))
    }

    guard launchIfNeeded,
          let appUrl = NSWorkspace.shared.urlForApplication(withBundleIdentifier: messagesBundleId) else {
        return nil
    }

    let config = NSWorkspace.OpenConfiguration()
    config.activates = activate
    var launched: NSRunningApplication?
    let semaphore = DispatchSemaphore(value: 0)
    NSWorkspace.shared.openApplication(at: appUrl, configuration: config) { app, _ in
        launched = app
        semaphore.signal()
    }
    _ = semaphore.wait(timeout: .now() + 5)
    guard let launched else { return nil }
    usleep(800_000)
    return (launched, AXUIElementCreateApplication(launched.processIdentifier))
}

func focusedWindow(_ app: AXUIElement) -> AXUIElement? {
    if let window = attr(app, kAXFocusedWindowAttribute) {
        return (window as! AXUIElement)
    }
    if let windows = attr(app, kAXWindowsAttribute) as? [AXUIElement], let first = windows.first {
        return first
    }
    return nil
}

func buildTree(_ element: AXUIElement, path: String = "0", depth: Int = 0, maxDepth: Int = 8, maxChildren: Int = 80) -> AXNode {
    var node = AXNode(
        path: path,
        role: attrString(element, kAXRoleAttribute),
        subrole: attrString(element, kAXSubroleAttribute),
        title: attrString(element, kAXTitleAttribute),
        description: attrString(element, kAXDescriptionAttribute),
        value: attrString(element, kAXValueAttribute),
        help: attrString(element, kAXHelpAttribute),
        identifier: attrString(element, "AXIdentifier"),
        focused: attrBool(element, kAXFocusedAttribute),
        selected: attrBool(element, kAXSelectedAttribute),
        actions: actions(element),
        children: []
    )

    if depth < maxDepth {
        let kids = children(element)
        for (index, child) in kids.prefix(maxChildren).enumerated() {
            node.children.append(buildTree(child, path: "\(path).\(index)", depth: depth + 1, maxDepth: maxDepth, maxChildren: maxChildren))
        }
    }
    return node
}

func walk(_ element: AXUIElement, depth: Int = 0, maxDepth: Int = 12, _ visit: (AXUIElement, AXUIElement?) -> Void) {
    guard depth <= maxDepth else { return }
    for child in children(element) {
        visit(child, element)
        walk(child, depth: depth + 1, maxDepth: maxDepth, visit)
    }
}

func findFirst(_ root: AXUIElement, maxDepth: Int = 12, where predicate: (AXUIElement) -> Bool) -> AXUIElement? {
    if predicate(root) { return root }
    var found: AXUIElement?
    walk(root, maxDepth: maxDepth) { element, _ in
        if found == nil && predicate(element) {
            found = element
        }
    }
    return found
}

func findFirstPath(_ root: AXUIElement, depth: Int = 0, maxDepth: Int = 12, where predicate: (AXUIElement) -> Bool) -> [AXUIElement]? {
    guard depth <= maxDepth else { return nil }
    if predicate(root) { return [root] }
    for child in children(root) {
        if let childPath = findFirstPath(child, depth: depth + 1, maxDepth: maxDepth, where: predicate) {
            return [root] + childPath
        }
    }
    return nil
}

func press(_ element: AXUIElement) -> Bool {
    AXUIElementPerformAction(element, kAXPressAction as CFString) == .success
}

func select(_ element: AXUIElement) -> Bool {
    AXUIElementSetAttributeValue(element, kAXSelectedAttribute as CFString, kCFBooleanTrue) == .success
}

func setValue(_ element: AXUIElement, _ value: String) -> Bool {
    AXUIElementSetAttributeValue(element, kAXValueAttribute as CFString, value as CFTypeRef) == .success
}

func valueString(_ element: AXUIElement) -> String {
    attrString(element, kAXValueAttribute) ?? ""
}

func postReturnKey() {
    let source = CGEventSource(stateID: .hidSystemState)
    let keyDown = CGEvent(keyboardEventSource: source, virtualKey: 36, keyDown: true)
    let keyUp = CGEvent(keyboardEventSource: source, virtualKey: 36, keyDown: false)
    keyDown?.post(tap: .cghidEventTap)
    keyUp?.post(tap: .cghidEventTap)
}

func clickPoint(_ point: CGPoint) {
    let source = CGEventSource(stateID: .hidSystemState)
    let move = CGEvent(mouseEventSource: source, mouseType: .mouseMoved, mouseCursorPosition: point, mouseButton: .left)
    let down = CGEvent(mouseEventSource: source, mouseType: .leftMouseDown, mouseCursorPosition: point, mouseButton: .left)
    let up = CGEvent(mouseEventSource: source, mouseType: .leftMouseUp, mouseCursorPosition: point, mouseButton: .left)
    move?.post(tap: .cghidEventTap)
    usleep(50_000)
    down?.post(tap: .cghidEventTap)
    usleep(80_000)
    up?.post(tap: .cghidEventTap)
}

func findTranscript(_ root: AXUIElement) -> AXUIElement? {
    findFirst(root, maxDepth: 10) { element in
        attrString(element, "AXIdentifier") == "TranscriptCollectionView"
    }
}

func scrollWheel(at point: CGPoint, delta: Int32) {
    let source = CGEventSource(stateID: .hidSystemState)
    guard let event = CGEvent(
        scrollWheelEvent2Source: source,
        units: .line,
        wheelCount: 1,
        wheel1: delta,
        wheel2: 0,
        wheel3: 0
    ) else {
        return
    }
    event.location = point
    event.post(tap: .cghidEventTap)
}

func findSearchField(_ root: AXUIElement) -> AXUIElement? {
    findFirst(root) { element in
        let role = attrString(element, kAXRoleAttribute)
        let subrole = attrString(element, kAXSubroleAttribute)
        let desc = attrString(element, kAXDescriptionAttribute)?.lowercased()
        return role == kAXTextFieldRole && (subrole == "AXSearchField" || desc == "search")
    }
}

func clearSearch(activate: Bool = true) -> BasicResult {
    guard isTrusted() else {
        return BasicResult(ok: false, trusted: false, message: "Accessibility permission is not granted.")
    }
    guard let (_, app) = appElement(launchIfNeeded: activate, activate: activate), let window = focusedWindow(app) else {
        return BasicResult(ok: false, trusted: true, message: "Messages is unavailable.")
    }
    guard let search = findSearchField(window) else {
        return BasicResult(ok: false, trusted: true, message: "Search field not found.")
    }
    guard setValue(search, "") else {
        return BasicResult(ok: false, trusted: true, message: "Could not clear search field.")
    }
    usleep(300_000)
    return BasicResult(ok: true, trusted: true, message: "Cleared search field.")
}

func findComposeField(_ root: AXUIElement) -> AXUIElement? {
    findFirst(root) { element in
        guard attrString(element, kAXRoleAttribute) == kAXTextFieldRole else { return false }
        if attrString(element, "AXIdentifier") == "messageBodyField" { return true }
        if let help = attrString(element, kAXHelpAttribute), !help.isEmpty { return true }
        return false
    }
}

func collectStaticTexts(_ root: AXUIElement) -> [String] {
    var values: [String] = []
    walk(root, maxDepth: 8) { element, _ in
        guard attrString(element, kAXRoleAttribute) == kAXStaticTextRole,
              let desc = attrString(element, kAXDescriptionAttribute),
              !desc.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            return
        }
        values.append(desc)
    }
    return values
}

func uniquePreservingOrder(_ values: [String]) -> [String] {
    var seen = Set<String>()
    var unique: [String] = []
    for value in values {
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, !seen.contains(trimmed) else { continue }
        seen.insert(trimmed)
        unique.append(trimmed)
    }
    return unique
}

func collectVisibleTexts(_ root: AXUIElement, maxDepth: Int = 10) -> [String] {
    var values: [String] = []
    func appendText(_ value: String?) {
        guard let value else { return }
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, trimmed.count <= 240 else { return }
        values.append(trimmed)
    }

    walk(root, maxDepth: maxDepth) { element, _ in
        let role = attrString(element, kAXRoleAttribute)
        guard [
            kAXStaticTextRole,
            kAXButtonRole,
            kAXTextFieldRole,
            "AXMenuButton",
            "AXGroup"
        ].contains(role ?? "") else {
            return
        }
        appendText(attrString(element, kAXDescriptionAttribute))
        appendText(attrString(element, kAXTitleAttribute))
        appendText(attrString(element, kAXValueAttribute))
        appendText(attrString(element, kAXHelpAttribute))
    }
    return uniquePreservingOrder(values)
}

func detailSurface(_ root: AXUIElement) -> AXUIElement? {
    findFirst(root, maxDepth: 10) { element in
        let role = attrString(element, kAXRoleAttribute)
        return role == "AXPopover" || role == "AXDialog" || role == "AXSheet"
    }
}

func extractEmails(from texts: [String]) -> [String] {
    let joined = texts.joined(separator: "\n")
    guard let regex = try? NSRegularExpression(pattern: "[A-Z0-9._%+-]+@[A-Z0-9.-]+\\.[A-Z]{2,}", options: [.caseInsensitive]) else {
        return []
    }
    let range = NSRange(joined.startIndex..<joined.endIndex, in: joined)
    return uniquePreservingOrder(regex.matches(in: joined, options: [], range: range).compactMap { match in
        guard let swiftRange = Range(match.range, in: joined) else { return nil }
        return String(joined[swiftRange]).lowercased()
    })
}

func extractPhoneNumbers(from texts: [String]) -> [String] {
    let joined = texts.joined(separator: "\n")
    guard let detector = try? NSDataDetector(types: NSTextCheckingResult.CheckingType.phoneNumber.rawValue) else {
        return []
    }
    let range = NSRange(joined.startIndex..<joined.endIndex, in: joined)
    return uniquePreservingOrder(detector.matches(in: joined, options: [], range: range).compactMap { match in
        guard let phone = match.phoneNumber else { return nil }
        return phone.trimmingCharacters(in: .whitespacesAndNewlines)
    })
}

func looksLikeIdentityDetails(_ texts: [String]) -> Bool {
    let lowered = texts.map { $0.lowercased() }
    if !extractPhoneNumbers(from: texts).isEmpty || !extractEmails(from: texts).isEmpty {
        return true
    }
    return lowered.contains(where: { text in
        text.contains("create new contact") ||
        text.contains("add to existing contact") ||
        text.contains("block contact") ||
        text.contains("send my current location") ||
        text.contains("stop sharing my location")
    })
}

func nameCandidates(from title: String?, texts: [String]) -> [String] {
    var names: [String] = []
    func addName(_ value: String?) {
        guard var value else { return }
        value = value.trimmingCharacters(in: .whitespacesAndNewlines)
        if value.lowercased().hasPrefix("maybe:") {
            value = String(value.dropFirst("maybe:".count)).trimmingCharacters(in: .whitespacesAndNewlines)
        }
        guard value.count >= 2,
              value.count <= 80,
              value.rangeOfCharacter(from: .decimalDigits) == nil,
              !value.contains("@"),
              !value.lowercased().contains("message"),
              !value.lowercased().contains("facetime") else {
            return
        }
        names.append(value)
    }

    if let title {
        let firstTitlePart = String(title.split(separator: ",").first ?? Substring(title))
        addName(firstTitlePart)
    }
    return uniquePreservingOrder(names)
}

func revealConversationIdentity() -> ConversationIdentityResult {
    guard isTrusted() else {
        return ConversationIdentityResult(ok: false, trusted: false, conversationTitle: nil, names: [], phoneNumbers: [], emails: [], uiTitles: [], rawTexts: [], message: "Accessibility permission is not granted.")
    }
    guard let (_, app) = appElement(launchIfNeeded: true, activate: true), let window = focusedWindow(app) else {
        return ConversationIdentityResult(ok: false, trusted: true, conversationTitle: nil, names: [], phoneNumbers: [], emails: [], uiTitles: [], rawTexts: [], message: "Messages is unavailable.")
    }
    let title = conversationTitle(window)
    let beforeTexts = collectVisibleTexts(window, maxDepth: 10)
    let before = Set(beforeTexts)
    guard let titleButton = findFirst(window, maxDepth: 6, where: { element in
        attrString(element, "AXIdentifier") == "ConversationTitle"
    }) else {
        return ConversationIdentityResult(ok: false, trusted: true, conversationTitle: title, names: nameCandidates(from: title, texts: []), phoneNumbers: [], emails: [], uiTitles: title.map { [$0] } ?? [], rawTexts: [], message: "Conversation title button not found.")
    }
    guard press(titleButton) else {
        return ConversationIdentityResult(ok: false, trusted: true, conversationTitle: title, names: nameCandidates(from: title, texts: []), phoneNumbers: [], emails: [], uiTitles: title.map { [$0] } ?? [], rawTexts: [], message: "Could not open conversation details.")
    }
    usleep(700_000)

    guard let (_, refreshedApp) = appElement(launchIfNeeded: false, activate: false) else {
        return ConversationIdentityResult(ok: false, trusted: true, conversationTitle: title, names: [], phoneNumbers: [], emails: [], uiTitles: title.map { [$0] } ?? [], rawTexts: [], message: "Messages disappeared after opening details.")
    }

    var rawTexts: [String]
    if let surface = detailSurface(refreshedApp) {
        rawTexts = collectVisibleTexts(surface, maxDepth: 12)
    } else if let refreshedWindow = focusedWindow(refreshedApp) {
        let after = collectVisibleTexts(refreshedWindow, maxDepth: 10)
        let diff = after.filter { !before.contains($0) }
        rawTexts = diff.isEmpty ? after : uniquePreservingOrder(diff)
    } else {
        rawTexts = []
    }

    if !looksLikeIdentityDetails(rawTexts),
       let retryWindow = focusedWindow(refreshedApp),
       let retryTitleButton = findFirst(retryWindow, maxDepth: 6, where: { element in
           attrString(element, "AXIdentifier") == "ConversationTitle"
       }) {
        let closedTexts = collectVisibleTexts(retryWindow, maxDepth: 10)
        let closedSet = Set(closedTexts)
        if press(retryTitleButton) {
            usleep(700_000)
            if let (_, retryApp) = appElement(launchIfNeeded: false, activate: false),
               let reopenedWindow = focusedWindow(retryApp) {
                if let surface = detailSurface(retryApp) {
                    rawTexts = collectVisibleTexts(surface, maxDepth: 12)
                } else {
                    let reopenedTexts = collectVisibleTexts(reopenedWindow, maxDepth: 10)
                    let reopenedDiff = reopenedTexts.filter { !closedSet.contains($0) }
                    if looksLikeIdentityDetails(reopenedDiff) {
                        rawTexts = uniquePreservingOrder(reopenedDiff)
                    }
                }
            }
        }
    }

    let uiTitles = uniquePreservingOrder([title].compactMap { $0 } + rawTexts.filter { text in
        text.lowercased().hasPrefix("maybe:") || text == title
    })
    return ConversationIdentityResult(
        ok: true,
        trusted: true,
        conversationTitle: title,
        names: nameCandidates(from: title, texts: rawTexts),
        phoneNumbers: extractPhoneNumbers(from: rawTexts),
        emails: extractEmails(from: rawTexts),
        uiTitles: uiTitles,
        rawTexts: rawTexts,
        message: nil
    )
}

func listVisibleConversations(activate: Bool = false) -> ConversationListResult {
    guard isTrusted() else {
        return ConversationListResult(ok: false, trusted: false, items: [])
    }
    guard let (_, app) = appElement(launchIfNeeded: activate, activate: activate), focusedWindow(app) != nil else {
        return ConversationListResult(ok: false, trusted: true, items: [])
    }

    _ = clearSearch(activate: activate)
    guard let (_, refreshedApp) = appElement(launchIfNeeded: activate, activate: activate), let refreshedWindow = focusedWindow(refreshedApp) else {
        return ConversationListResult(ok: false, trusted: true, items: [])
    }

    let windowFrame = attrRect(refreshedWindow, "AXFrame")
    var items: [ConversationListItem] = []
    walk(refreshedWindow, maxDepth: 14) { element, _ in
        guard attrString(element, kAXRoleAttribute) == kAXStaticTextRole,
              let desc = attrString(element, kAXDescriptionAttribute),
              desc.contains(",") else {
            return
        }
        let frame = attrRect(element, "AXFrame")
        if let frame, let windowFrame {
            let isProbablySidebar = frame.minX < windowFrame.minX + 320
            if !isProbablySidebar { return }
        }
        guard !desc.hasPrefix("Your iMessage,"),
              !desc.hasPrefix("Message,") else {
            return
        }
        items.append(ConversationListItem(
            description: desc,
            selected: attrBool(element, kAXSelectedAttribute),
            frame: rectInfo(frame),
            staticTexts: [desc]
        ))
    }

    return ConversationListResult(ok: true, trusted: true, items: items)
}

func findSidebarConversationText(_ root: AXUIElement, description: String) -> AXUIElement? {
    let windowFrame = attrRect(root, "AXFrame")
    return findFirst(root, maxDepth: 14) { element in
        guard attrString(element, kAXRoleAttribute) == kAXStaticTextRole,
              attrString(element, kAXDescriptionAttribute) == description else {
            return false
        }
        guard let frame = attrRect(element, "AXFrame"), let windowFrame else { return true }
        return frame.minX < windowFrame.minX + 320
    }
}

func findSidebarConversationTarget(_ root: AXUIElement, description: String) -> SidebarOpenTarget? {
    let windowFrame = attrRect(root, "AXFrame")
    guard let path = findFirstPath(root, maxDepth: 14, where: { element in
        guard attrString(element, kAXRoleAttribute) == kAXStaticTextRole,
              attrString(element, kAXDescriptionAttribute) == description else {
            return false
        }
        guard let frame = attrRect(element, "AXFrame"), let windowFrame else { return true }
        return frame.minX < windowFrame.minX + 320
    }), let element = path.last else {
        return nil
    }
    return SidebarOpenTarget(element: element, path: path)
}

func activateSidebarTarget(_ target: SidebarOpenTarget, foreground: Bool) -> Bool {
    if !foreground {
        for element in target.path.reversed() {
            if press(element) { return true }
        }
        for element in target.path.reversed() {
            if select(element) { return true }
        }
        return false
    }

    guard let frame = attrRect(target.element, "AXFrame") else { return false }
    clickPoint(CGPoint(x: frame.midX, y: frame.midY))
    return true
}

func openSidebarConversation(description: String, activate: Bool = true) -> BasicResult {
    guard isTrusted() else {
        return BasicResult(ok: false, trusted: false, message: "Accessibility permission is not granted.")
    }
    guard let (_, app) = appElement(launchIfNeeded: activate, activate: activate), focusedWindow(app) != nil else {
        return BasicResult(ok: false, trusted: true, message: "Messages is unavailable.")
    }

    _ = clearSearch(activate: activate)
    guard let (_, refreshedApp) = appElement(launchIfNeeded: activate, activate: activate), let refreshedWindow = focusedWindow(refreshedApp) else {
        return BasicResult(ok: false, trusted: true, message: "Messages disappeared after clearing search.")
    }
    guard let target = findSidebarConversationTarget(refreshedWindow, description: description) else {
        return BasicResult(ok: false, trusted: true, message: "Sidebar conversation not found.")
    }

    guard activateSidebarTarget(target, foreground: activate) else {
        return BasicResult(ok: false, trusted: true, message: activate ? "Sidebar conversation found but could not be clicked." : "Sidebar conversation found but could not be opened in background.")
    }
    usleep(700_000)
    return BasicResult(ok: true, trusted: true, message: activate ? "Opened sidebar conversation." : "Opened sidebar conversation in background.")
}

func findConversationResultButton(_ root: AXUIElement, named name: String) -> AXUIElement? {
    let lowerName = name.lowercased()
    return findFirst(root, maxDepth: 12, where: { element in
        guard attrString(element, kAXRoleAttribute) == kAXButtonRole,
              let desc = attrString(element, kAXDescriptionAttribute)?.lowercased() else {
            return false
        }
        return desc == lowerName
    })
}

func openConversation(search query: String, resultName: String) -> BasicResult {
    guard isTrusted() else {
        return BasicResult(ok: false, trusted: false, message: "Accessibility permission is not granted.")
    }
    guard let (_, app) = appElement(), let window = focusedWindow(app) else {
        return BasicResult(ok: false, trusted: true, message: "Messages is unavailable.")
    }
    guard let search = findSearchField(window) else {
        return BasicResult(ok: false, trusted: true, message: "Search field not found.")
    }

    _ = setValue(search, query)
    var button: AXUIElement?
    for _ in 0..<16 {
        usleep(250_000)
        guard let (_, refreshedApp) = appElement(), let refreshedWindow = focusedWindow(refreshedApp) else {
            return BasicResult(ok: false, trusted: true, message: "Messages disappeared after search.")
        }
        if conversationTitle(refreshedWindow)?.lowercased() == resultName.lowercased() {
            return BasicResult(ok: true, trusted: true, message: "Already open: \(resultName).")
        }
        button = findConversationResultButton(refreshedWindow, named: resultName)
        if button != nil { break }
    }

    guard let button else {
        return BasicResult(ok: false, trusted: true, message: "Conversation result not found for \(resultName).")
    }

    guard press(button) else {
        return BasicResult(ok: false, trusted: true, message: "Conversation result found but could not be opened.")
    }
    usleep(500_000)
    return BasicResult(ok: true, trusted: true, message: "Opened \(resultName).")
}

func sendCurrent(text: String) -> BasicResult {
    guard isTrusted() else {
        return BasicResult(ok: false, trusted: false, message: "Accessibility permission is not granted.")
    }
    guard let (_, app) = appElement(), let window = focusedWindow(app) else {
        return BasicResult(ok: false, trusted: true, message: "Messages is unavailable.")
    }
    guard let compose = findComposeField(window) else {
        return BasicResult(ok: false, trusted: true, message: "Compose field not found.")
    }
    if let frame = attrRect(compose, "AXFrame") {
        clickPoint(CGPoint(x: frame.midX, y: frame.midY))
        usleep(100_000)
    }
    guard setValue(compose, text) else {
        return BasicResult(ok: false, trusted: true, message: "Could not set compose text.")
    }
    if let frame = attrRect(compose, "AXFrame") {
        clickPoint(CGPoint(x: frame.midX, y: frame.midY))
        usleep(100_000)
    }
    guard valueString(compose).trimmingCharacters(in: .whitespacesAndNewlines) == text.trimmingCharacters(in: .whitespacesAndNewlines) else {
        return BasicResult(ok: false, trusted: true, message: "Compose text did not match requested send text.")
    }
    postReturnKey()
    usleep(1_000_000)

    guard let (_, refreshedApp) = appElement(), let refreshedWindow = focusedWindow(refreshedApp),
          let refreshedCompose = findComposeField(refreshedWindow) else {
        return BasicResult(ok: false, trusted: true, message: "Could not verify compose field after pressing return.")
    }
    if valueString(refreshedCompose).trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
        return BasicResult(ok: true, trusted: true, message: "Sent text to current conversation.")
    }
    return BasicResult(ok: false, trusted: true, message: "Return did not send; compose field still contains text.")
}

func conversationTitle(_ root: AXUIElement) -> String? {
    if let titleButton = findFirst(root, maxDepth: 5, where: { element in
        attrString(element, "AXIdentifier") == "ConversationTitle"
    }) {
        return attrString(titleButton, kAXDescriptionAttribute) ?? attrString(titleButton, kAXTitleAttribute)
    }
    return attrString(root, kAXTitleAttribute)
}

func parseSender(direction: String, raw: String?) -> String? {
    guard direction == "incoming", let raw else { return nil }
    if let comma = raw.firstIndex(of: ",") {
        return String(raw[..<comma])
    }
    return raw
}

func inferDirection(elementFrame: CGRect?, parentFrame: CGRect?, windowFrame: CGRect?) -> String? {
    guard let frame = parentFrame ?? elementFrame,
          let windowFrame else {
        return nil
    }
    return frame.midX > windowFrame.midX ? "outgoing" : "incoming"
}

func visibleMessages(_ root: AXUIElement) -> [VisibleMessage] {
    var messages: [VisibleMessage] = []
    let windowFrame = attrRect(root, "AXFrame")

    walk(root, maxDepth: 14) { element, parent in
        guard attrString(element, "AXIdentifier") == "CKBalloonTextView",
              let text = attrString(element, kAXValueAttribute),
              !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            return
        }

        let parentDesc = parent.flatMap { attrString($0, kAXDescriptionAttribute) }
        let elementFrame = attrRect(element, "AXFrame")
        let parentFrame = parent.flatMap { attrRect($0, "AXFrame") }
        let direction: String
        if parentDesc?.hasPrefix("Your iMessage") == true || parentDesc?.hasPrefix("Your Text Message") == true {
            direction = "outgoing"
        } else if parentDesc?.hasPrefix("Message") == true {
            direction = inferDirection(elementFrame: elementFrame, parentFrame: parentFrame, windowFrame: windowFrame) ?? "unknown"
        } else {
            direction = "incoming"
        }

        messages.append(VisibleMessage(
            direction: direction,
            sender: parseSender(direction: direction, raw: parentDesc),
            text: text,
            rawDescription: parentDesc,
            frame: rectInfo(elementFrame),
            parentFrame: rectInfo(parentFrame)
        ))
    }

    var unique: [VisibleMessage] = []
    var seen = Set<String>()
    for msg in messages {
        let key = "\(msg.direction)|\(msg.sender ?? "")|\(msg.text)|\(msg.rawDescription ?? "")"
        if !seen.contains(key) {
            seen.insert(key)
            unique.append(msg)
        }
    }
    return unique
}

func readVisible(activate: Bool = false) -> ReadVisibleResult {
    guard isTrusted() else {
        return ReadVisibleResult(ok: false, trusted: false, conversationTitle: nil, messages: [])
    }
    guard let (_, app) = appElement(launchIfNeeded: activate, activate: activate), let window = focusedWindow(app) else {
        return ReadVisibleResult(ok: false, trusted: true, conversationTitle: nil, messages: [])
    }
    return ReadVisibleResult(
        ok: true,
        trusted: true,
        conversationTitle: conversationTitle(window),
        messages: visibleMessages(window)
    )
}

func scrollTranscript(direction: String, pages: Int = 1, activate: Bool = true) -> BasicResult {
    guard isTrusted() else {
        return BasicResult(ok: false, trusted: false, message: "Accessibility permission is not granted.")
    }
    guard ["older", "newer"].contains(direction) else {
        return BasicResult(ok: false, trusted: true, message: "Direction must be older or newer.")
    }
    guard let (_, app) = appElement(launchIfNeeded: activate, activate: activate), let window = focusedWindow(app) else {
        return BasicResult(ok: false, trusted: true, message: "Messages is unavailable.")
    }
    guard let transcript = findTranscript(window) else {
        return BasicResult(ok: false, trusted: true, message: "Transcript not found.")
    }

    let requestedPages = max(1, min(pages, 20))
    let primaryAction = direction == "older" ? "AXScrollUpByPage" : "AXScrollDownByPage"
    let fallbackDelta: Int32 = direction == "older" ? 8 : -8
    var performed = false

    for _ in 0..<requestedPages {
        if actions(transcript).contains(primaryAction),
           AXUIElementPerformAction(transcript, primaryAction as CFString) == .success {
            performed = true
        } else if let frame = attrRect(transcript, "AXFrame") {
            scrollWheel(at: CGPoint(x: frame.midX, y: frame.midY), delta: fallbackDelta)
            performed = true
        }
        usleep(350_000)
    }

    return BasicResult(
        ok: performed,
        trusted: true,
        message: performed ? "Scrolled transcript \(direction)." : "Could not scroll transcript."
    )
}

let args = CommandLine.arguments.dropFirst()
guard let command = args.first else {
    fputs("Usage: messages-ax <permission|snapshot|read-visible|identity|list-conversations|clear-search|open-sidebar|scroll-transcript|open|send> [...]\n", stderr)
    exit(2)
}

switch command {
case "permission":
    let prompt = args.dropFirst().contains("--prompt")
    printJSON(BasicResult(ok: isTrusted(prompt: prompt), trusted: isTrusted(), message: nil))
case "snapshot":
    let activate = args.dropFirst().contains("--activate")
    guard isTrusted() else {
        printJSON(BasicResult(ok: false, trusted: false, message: "Accessibility permission is not granted."))
        exit(1)
    }
    guard let (_, app) = appElement(launchIfNeeded: activate, activate: activate), let window = focusedWindow(app) else {
        printJSON(BasicResult(ok: false, trusted: true, message: "Messages is unavailable."))
        exit(1)
    }
    printJSON(buildTree(window))
case "read-visible":
    let activate = args.dropFirst().contains("--activate")
    printJSON(readVisible(activate: activate))
case "identity":
    printJSON(revealConversationIdentity())
case "list-conversations":
    let activate = args.dropFirst().contains("--activate")
    printJSON(listVisibleConversations(activate: activate))
case "clear-search":
    let activate = !args.dropFirst().contains("--background")
    printJSON(clearSearch(activate: activate))
case "open":
    let rest = Array(args.dropFirst())
    let separatorIndex = rest.firstIndex(of: "--result")
    let queryParts = separatorIndex.map { Array(rest[..<$0]) } ?? rest
    let resultParts = separatorIndex.map { Array(rest[rest.index(after: $0)...]) } ?? queryParts
    let query = queryParts.joined(separator: " ").trimmingCharacters(in: .whitespacesAndNewlines)
    let resultName = resultParts.joined(separator: " ").trimmingCharacters(in: .whitespacesAndNewlines)
    guard !query.isEmpty && !resultName.isEmpty else {
        fputs("Usage: messages-ax open <search-query> [--result <conversation-result-name>]\n", stderr)
        exit(2)
    }
    printJSON(openConversation(search: query, resultName: resultName))
case "open-sidebar":
    let rest = Array(args.dropFirst())
    let background = rest.contains("--background")
    let description = rest
        .filter { $0 != "--background" }
        .joined(separator: " ")
        .trimmingCharacters(in: .whitespacesAndNewlines)
    guard !description.isEmpty else {
        fputs("Usage: messages-ax open-sidebar [--background] <exact-sidebar-description>\n", stderr)
        exit(2)
    }
    printJSON(openSidebarConversation(description: description, activate: !background))
case "scroll-transcript":
    let rest = Array(args.dropFirst())
    let background = rest.contains("--background")
    let pagesIndex = rest.firstIndex(of: "--pages")
    let pages: Int
    if let pagesIndex,
       rest.indices.contains(rest.index(after: pagesIndex)),
       let parsed = Int(rest[rest.index(after: pagesIndex)]) {
        pages = parsed
    } else {
        pages = 1
    }
    let direction = rest.first(where: { value in
        value == "older" || value == "newer"
    }) ?? ""
    guard !direction.isEmpty else {
        fputs("Usage: messages-ax scroll-transcript <older|newer> [--pages N] [--background]\n", stderr)
        exit(2)
    }
    printJSON(scrollTranscript(direction: direction, pages: pages, activate: !background))
case "send":
    let text = args.dropFirst().joined(separator: " ")
    guard !text.isEmpty else {
        fputs("Usage: messages-ax send <text>\n", stderr)
        exit(2)
    }
    printJSON(sendCurrent(text: text))
default:
    fputs("Unknown command: \(command)\n", stderr)
    exit(2)
}
