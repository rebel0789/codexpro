import AppKit
import ApplicationServices
import CoreGraphics
import Foundation
import ScreenCaptureKit

enum HelperError: Error, CustomStringConvertible {
    case message(String)
    var description: String {
        switch self { case .message(let text): return text }
    }
}

func jsonPrint(_ value: Any) throws {
    let data = try JSONSerialization.data(withJSONObject: value, options: [])
    FileHandle.standardOutput.write(data)
    FileHandle.standardOutput.write(Data("\n".utf8))
}

func argument(_ name: String) -> String? {
    guard let index = CommandLine.arguments.firstIndex(of: name), index + 1 < CommandLine.arguments.count else { return nil }
    return CommandLine.arguments[index + 1]
}

func runningApp(_ bundleId: String) throws -> NSRunningApplication {
    guard let app = NSRunningApplication.runningApplications(withBundleIdentifier: bundleId).first else {
        throw HelperError.message("computer_use_app_not_running: \(bundleId)")
    }
    return app
}

func axValue(_ element: AXUIElement, _ attribute: CFString) -> AnyObject? {
    var value: CFTypeRef?
    guard AXUIElementCopyAttributeValue(element, attribute, &value) == .success else { return nil }
    return value
}

func axString(_ element: AXUIElement, _ attribute: CFString) -> String? {
    return axValue(element, attribute) as? String
}

func axBool(_ element: AXUIElement, _ attribute: CFString) -> Bool? {
    return (axValue(element, attribute) as? NSNumber)?.boolValue
}

func pointValue(_ value: AnyObject?) -> CGPoint? {
    guard let ax = value, CFGetTypeID(ax) == AXValueGetTypeID() else { return nil }
    var point = CGPoint.zero
    guard AXValueGetValue(ax as! AXValue, .cgPoint, &point) else { return nil }
    return point
}

func sizeValue(_ value: AnyObject?) -> CGSize? {
    guard let ax = value, CFGetTypeID(ax) == AXValueGetTypeID() else { return nil }
    var size = CGSize.zero
    guard AXValueGetValue(ax as! AXValue, .cgSize, &size) else { return nil }
    return size
}

func children(_ element: AXUIElement) -> [AXUIElement] {
    return (axValue(element, kAXChildrenAttribute as CFString) as? [AXUIElement]) ?? []
}

func locate(_ root: AXUIElement, path: String) throws -> AXUIElement {
    if path == "root" || path.isEmpty { return root }
    var current = root
    for part in path.split(separator: "/") {
        guard let index = Int(part) else { throw HelperError.message("computer_use_invalid_element_id") }
        let items = children(current)
        guard index >= 0 && index < items.count else { throw HelperError.message("computer_use_stale_element_id") }
        current = items[index]
    }
    return current
}

func listApps() throws {
    let allowlist = Set((argument("--allowlist") ?? "").split(separator: ",").map(String.init))
    let apps = NSWorkspace.shared.runningApplications.compactMap { app -> [String: Any]? in
        guard let bundle = app.bundleIdentifier else { return nil }
        guard allowlist.contains(bundle) else { return nil }
        return [
            "app_id": bundle,
            "name": app.localizedName ?? bundle,
            "pid": Int(app.processIdentifier),
            "active": app.isActive
        ]
    }
    try jsonPrint(["apps": apps])
}

func getState() throws {
    guard let bundle = argument("--app") else { throw HelperError.message("computer_use_app_required") }
    let maxElements = max(1, min(Int(argument("--max-elements") ?? "400") ?? 400, 1000))
    let app = try runningApp(bundle)
    guard AXIsProcessTrusted() else { throw HelperError.message("computer_use_accessibility_permission_required") }
    let root = AXUIElementCreateApplication(app.processIdentifier)
    var out: [[String: Any]] = []
    var truncated = false

    func walk(_ element: AXUIElement, _ id: String, _ depth: Int) {
        if out.count >= maxElements { truncated = true; return }
        var item: [String: Any] = ["id": id]
        if let value = axString(element, kAXRoleAttribute as CFString) { item["role"] = value }
        if let value = axString(element, kAXTitleAttribute as CFString), !value.isEmpty { item["title"] = value }
        if let value = axString(element, kAXDescriptionAttribute as CFString), !value.isEmpty { item["description"] = value }
        if let value = axString(element, kAXValueAttribute as CFString), !value.isEmpty { item["value"] = String(value.prefix(1000)) }
        if let value = axBool(element, kAXEnabledAttribute as CFString) { item["enabled"] = value }
        if let point = pointValue(axValue(element, kAXPositionAttribute as CFString)), point.x.isFinite, point.y.isFinite {
            item["position"] = ["x": point.x, "y": point.y]
        }
        if let size = sizeValue(axValue(element, kAXSizeAttribute as CFString)), size.width.isFinite, size.height.isFinite {
            item["size"] = ["width": size.width, "height": size.height]
        }
        out.append(item)
        if depth >= 12 { return }
        for (index, child) in children(element).enumerated() {
            if out.count >= maxElements { truncated = true; break }
            walk(child, id == "root" ? "\(index)" : "\(id)/\(index)", depth + 1)
        }
    }

    walk(root, "root", 0)
    try jsonPrint([
        "app_id": bundle,
        "app_name": app.localizedName ?? bundle,
        "pid": Int(app.processIdentifier),
        "trusted": true,
        "elements": out,
        "truncated": truncated
    ])
}

func click() throws {
    guard let bundle = argument("--app"), let elementId = argument("--element") else {
        throw HelperError.message("computer_use_click_arguments_required")
    }
    let app = try runningApp(bundle)
    guard AXIsProcessTrusted() else { throw HelperError.message("computer_use_accessibility_permission_required") }
    let root = AXUIElementCreateApplication(app.processIdentifier)
    let target = try locate(root, path: elementId)
    let result = AXUIElementPerformAction(target, kAXPressAction as CFString)
    guard result == .success else { throw HelperError.message("computer_use_ax_press_failed: \(result.rawValue)") }
    try jsonPrint(["ok": true, "app_id": bundle, "element_id": elementId, "action": "press"])
}

let keyCodes: [String: CGKeyCode] = [
    "a":0,"s":1,"d":2,"f":3,"h":4,"g":5,"z":6,"x":7,"c":8,"v":9,"b":11,"q":12,"w":13,"e":14,"r":15,"y":16,"t":17,
    "1":18,"2":19,"3":20,"4":21,"6":22,"5":23,"=":24,"9":25,"7":26,"-":27,"8":28,"0":29,
    "o":31,"u":32,"i":34,"p":35,"l":37,"j":38,"k":40,"n":45,"m":46,
    "return":36,"enter":36,"tab":48,"space":49,"escape":53,"esc":53,"left":123,"right":124,"down":125,"up":126
]

func pressKey() throws {
    guard let bundle = argument("--app"), let rawKey = argument("--key") else {
        throw HelperError.message("computer_use_key_arguments_required")
    }
    let app = try runningApp(bundle)
    _ = app.activate()
    let parts = rawKey.lowercased().split(separator: "+").map(String.init)
    guard let keyName = parts.last, let code = keyCodes[keyName] else { throw HelperError.message("computer_use_unsupported_key: \(rawKey)") }
    var flags: CGEventFlags = []
    for modifier in parts.dropLast() {
        switch modifier {
        case "cmd", "command", "super": flags.insert(.maskCommand)
        case "ctrl", "control": flags.insert(.maskControl)
        case "alt", "option": flags.insert(.maskAlternate)
        case "shift": flags.insert(.maskShift)
        default: throw HelperError.message("computer_use_unsupported_modifier: \(modifier)")
        }
    }
    guard let down = CGEvent(keyboardEventSource: nil, virtualKey: code, keyDown: true),
          let up = CGEvent(keyboardEventSource: nil, virtualKey: code, keyDown: false) else {
        throw HelperError.message("computer_use_key_event_failed")
    }
    down.flags = flags
    up.flags = flags
    down.post(tap: .cghidEventTap)
    up.post(tap: .cghidEventTap)
    try jsonPrint(["ok": true, "app_id": bundle, "key": rawKey])
}

@available(macOS 14.0, *)
func screenshot() async throws {
    guard let bundle = argument("--app"), let output = argument("--output") else {
        throw HelperError.message("computer_use_screenshot_arguments_required")
    }
    let app = try runningApp(bundle)
    guard CGPreflightScreenCaptureAccess() else { throw HelperError.message("computer_use_screen_recording_permission_required") }
    let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
    let candidates = content.windows.filter { window in
        window.owningApplication?.processID == app.processIdentifier && window.frame.width > 20 && window.frame.height > 20
    }.sorted { $0.frame.width * $0.frame.height > $1.frame.width * $1.frame.height }
    guard let window = candidates.first else { throw HelperError.message("computer_use_window_screenshot_failed") }
    let filter = SCContentFilter(desktopIndependentWindow: window)
    let configuration = SCStreamConfiguration()
    configuration.width = Int(window.frame.width)
    configuration.height = Int(window.frame.height)
    configuration.showsCursor = false
    let image = try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: configuration)
    let rep = NSBitmapImageRep(cgImage: image)
    guard let png = rep.representation(using: .png, properties: [:]) else { throw HelperError.message("computer_use_png_encoding_failed") }
    try png.write(to: URL(fileURLWithPath: output), options: .atomic)
    try jsonPrint(["ok": true, "app_id": bundle, "width": image.width, "height": image.height])
}

@main
enum Main {
    static func main() async {
        _ = await MainActor.run { NSApplication.shared }
        do {
            guard CommandLine.arguments.count >= 2 else { throw HelperError.message("computer_use_command_required") }
            switch CommandLine.arguments[1] {
            case "list-apps": try listApps()
            case "get-state": try getState()
            case "click": try click()
            case "press-key": try pressKey()
            case "screenshot":
                guard #available(macOS 14.0, *) else { throw HelperError.message("computer_use_screenshot_requires_macos_14") }
                try await screenshot()
            default: throw HelperError.message("computer_use_unknown_command")
            }
        } catch {
            FileHandle.standardError.write(Data("\(error)\n".utf8))
            exit(1)
        }
    }
}
