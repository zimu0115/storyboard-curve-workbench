import Cocoa
import CoreImage
import QuartzCore
import WebKit
import UniformTypeIdentifiers

func describeError(_ error: Error) {
    let alert = NSAlert(error: error)
    alert.runModal()
}

private enum WorkbenchAppearance: String, CaseIterable {
    case system, light, dark

    var title: String {
        switch self {
        case .system: return "跟随系统"
        case .light: return "浅色"
        case .dark: return "深色"
        }
    }

    var nativeAppearance: NSAppearance? {
        switch self {
        case .system: return nil
        case .light: return NSAppearance(named: .aqua)
        case .dark: return NSAppearance(named: .darkAqua)
        }
    }
}

private final class OpeningMarkView: NSImageView {
    private let lightMark: NSImage
    private let darkMark: NSImage

    init(mark: NSImage) {
        lightMark = mark
        if let source = mark.cgImage(forProposedRect: nil, context: nil, hints: nil) {
            let inverse = CIImage(cgImage: source).applyingFilter("CIColorInvert")
            let rep = NSCIImageRep(ciImage: inverse)
            rep.size = mark.size
            darkMark = NSImage(size: mark.size)
            darkMark.addRepresentation(rep)
        } else {
            darkMark = mark
        }
        super.init(frame: .zero)
        imageScaling = .scaleProportionallyUpOrDown
        wantsLayer = true
        applyMarkAppearance()
    }

    required init?(coder: NSCoder) { return nil }

    override func viewDidChangeEffectiveAppearance() {
        super.viewDidChangeEffectiveAppearance()
        applyMarkAppearance()
    }

    private func applyMarkAppearance() {
        let dark = effectiveAppearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua
        image = dark ? darkMark : lightMark

        let glow = NSShadow()
        glow.shadowColor = dark ? NSColor(white: 1, alpha: 0.065) : NSColor(white: 0.55, alpha: 0.26)
        glow.shadowOffset = NSSize(width: 0, height: -6)
        glow.shadowBlurRadius = dark ? 24 : 12
        shadow = glow
    }
}

private final class AppearanceSnapshotView: NSImageView {
    override func hitTest(_ point: NSPoint) -> NSView? { nil }
}

final class Studio: NSObject, NSApplicationDelegate, NSWindowDelegate, NSToolbarDelegate, WKUIDelegate, WKNavigationDelegate, WKScriptMessageHandlerWithReply {
    var window: NSWindow!
    var web: WKWebView!
    var page: URL!
    var library: [String: Any] = [:]
    var store: URL!
    private var storyboardImages: StoryboardImages!
    private var importDocument: URL?
    var ready = false
    var quitting = false
    private var scrollMonitor: Any?
    private var scrollSamples: [[String: Any]] = []
    private var sendingScroll = false
    private var forwardDeviceScroll = true
    private let zoomSteps = [75, 90, 100, 110, 125, 150]
    private let zoomPreference = "WorkbenchInterfaceZoomPercent"
    private var zoomPercent = 100
    private var zoomMonitor: Any?
    private let openingMarkDuration: TimeInterval = 0.2
    private weak var openingOverlay: NSView?
    private weak var openingBackdrop: NSBox?
    private weak var pendingOpeningLockup: NSStackView?
    private weak var openingWaitingForReveal: NSStackView?
    private let appearanceKey = "WorkbenchAppearance"
    private var appearanceMode: WorkbenchAppearance = .dark
    private let appearanceMenu = NSMenu(title: "外观")
    private let appearanceToolID = NSToolbarItem.Identifier("appearance")
    private weak var appearanceTool: NSToolbarItem?
    private var appearanceObservation: NSKeyValueObservation?
    private var appearanceChange = 0
    private var appearanceSnapshots: [AppearanceSnapshotView] = []

    private var nextAppearance: WorkbenchAppearance {
        switch appearanceMode {
        case .light: return .dark
        case .dark: return .light
        case .system:
            return NSApp.effectiveAppearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua ? .light : .dark
        }
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        appearanceMode = UserDefaults.standard.string(forKey: appearanceKey).flatMap(WorkbenchAppearance.init(rawValue:)) ?? .dark
        NSApp.appearance = appearanceMode.nativeAppearance
        do {
            let fm = FileManager.default
            let support = try fm.url(for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
            let directory = support.appendingPathComponent("分镜曲线工作台开源版", isDirectory: true)
            try fm.createDirectory(at: directory, withIntermediateDirectories: true)
            store = directory.appendingPathComponent("草稿.json")
            if fm.fileExists(atPath: store.path) {
                let object = try JSONSerialization.jsonObject(with: Data(contentsOf: store))
                guard let saved = object as? [String: Any], saved["drafts"] is [String: Any] else {
                    throw CocoaError(.fileReadCorruptFile)
                }
                library = saved
            }
            guard let entry = Bundle.main.url(forResource: "分镜曲线工作台", withExtension: "html") else {
                throw CocoaError(.fileNoSuchFile)
            }
            page = entry
            let settings = WKWebViewConfiguration()
            storyboardImages = StoryboardImages(directory: directory.appendingPathComponent("分镜预览", isDirectory: true))
            settings.setURLSchemeHandler(storyboardImages, forURLScheme: "storyboard-image")
            settings.userContentController.addScriptMessageHandler(self, contentWorld: .page, name: "studio")
            let json = try JSONSerialization.data(withJSONObject: library)
            let storedZoom = UserDefaults.standard.integer(forKey: zoomPreference)
            if zoomSteps.contains(storedZoom) { zoomPercent = storedZoom }
            let initial = "window.studioInitialZoom = \(zoomPercent); window.studioNativeScroll = true; window.studioLibrary = JSON.parse(" + String(decoding: try JSONEncoder().encode(String(decoding: json, as: UTF8.self)), as: UTF8.self) + ");"
            settings.userContentController.addUserScript(WKUserScript(source: initial, injectionTime: .atDocumentStart, forMainFrameOnly: true))
            let themeScript = """
            (() => {
                const system = matchMedia('(prefers-color-scheme: dark)');
                let mode = '\(appearanceMode.rawValue)';
                const apply = () => {
                    if (document.documentElement) document.documentElement.dataset.theme =
                        mode === 'system' ? (system.matches ? 'dark' : 'light') : mode;
                };
                window.setWorkbenchAppearance = choice => { mode = choice; apply(); };
                system.addEventListener('change', apply);
                apply();
            })();
            """
            settings.userContentController.addUserScript(WKUserScript(source: themeScript, injectionTime: .atDocumentStart, forMainFrameOnly: true))
            web = WKWebView(frame: .zero, configuration: settings)
            web.pageZoom = CGFloat(zoomPercent) / 100
            web.allowsBackForwardNavigationGestures = false
            web.uiDelegate = self
            web.navigationDelegate = self
            buildMenu()
            window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1200, height: 800), styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false)
            window.title = "子牧曲镜工作台"
            window.titleVisibility = .hidden
            window.titlebarAppearsTransparent = true
            // Match the canvas behind the native toolbar and before the document paints.
            let canvas = NSColor(name: nil) { appearance in
                if appearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua {
                    return NSColor(srgbRed: 16/255, green: 17/255, blue: 20/255, alpha: 1)
                }
                return NSColor(srgbRed: 245/255, green: 245/255, blue: 247/255, alpha: 1)
            }
            window.backgroundColor = canvas
            web.underPageBackgroundColor = canvas
            window.titlebarSeparatorStyle = .none
            window.toolbarStyle = .unifiedCompact
            let toolbar = NSToolbar(identifier: "StoryboardTools")
            toolbar.delegate = self
            toolbar.displayMode = .iconOnly
            toolbar.showsBaselineSeparator = false
            window.toolbar = toolbar
            appearanceObservation = NSApp.observe(\.effectiveAppearance) { [weak self] _, _ in
                guard let self, self.appearanceMode == .system, let item = self.appearanceTool else { return }
                self.updateAppearanceTool(item)
            }
            window.minSize = NSSize(width: 650, height: 480)
            let content = NSView(frame: window.contentView!.bounds)
            window.contentView = content
            web.frame = content.bounds
            web.autoresizingMask = [.width, .height]
            content.addSubview(web)
            window.initialFirstResponder = web
            observeChartScroll()
            observeZoomKeys()
            window.center()
            window.setFrameAutosaveName("StoryboardMainWindow")
            window.delegate = self
            showOpening()
            window.makeKeyAndOrderFront(nil)
            web.loadFileURL(entry, allowingReadAccessTo: entry.deletingLastPathComponent())
            NSApp.activate(ignoringOtherApps: true)
            startOpeningIfVisible()
        } catch {
            describeError(error)
            NSApp.terminate(nil)
        }
    }

    @objc private func showOpening() {
        guard openingOverlay == nil, let content = window.contentView,
              let url = Bundle.main.url(forResource: "WorkbenchMark", withExtension: "png"),
              let mark = NSImage(contentsOf: url) else { return }

        let overlay = NSView(frame: content.bounds)
        overlay.autoresizingMask = [.width, .height]
        overlay.wantsLayer = true
        content.addSubview(overlay, positioned: .above, relativeTo: web)
        openingOverlay = overlay

        let backdrop = NSBox(frame: overlay.bounds)
        backdrop.boxType = .custom
        backdrop.borderWidth = 0
        backdrop.titlePosition = .noTitle
        backdrop.fillColor = window.backgroundColor
        backdrop.autoresizingMask = [.width, .height]
        overlay.addSubview(backdrop)
        openingBackdrop = backdrop

        let icon = OpeningMarkView(mark: mark)
        let title = NSTextField(labelWithString: "子牧曲镜工作台")
        title.font = .systemFont(ofSize: 15, weight: .semibold)
        title.textColor = .labelColor
        let lockup = NSStackView(views: [icon, title])
        lockup.orientation = .vertical
        lockup.alignment = .centerX
        lockup.spacing = 9
        lockup.edgeInsets = NSEdgeInsets(top: 24, left: 24, bottom: 24, right: 24)
        lockup.wantsLayer = true
        lockup.layerUsesCoreImageFilters = true
        lockup.translatesAutoresizingMaskIntoConstraints = false
        overlay.addSubview(lockup)
        NSLayoutConstraint.activate([
            icon.widthAnchor.constraint(equalToConstant: 104),
            icon.heightAnchor.constraint(equalToConstant: 104),
            lockup.centerXAnchor.constraint(equalTo: overlay.centerXAnchor),
            lockup.centerYAnchor.constraint(equalTo: overlay.centerYAnchor)
        ])

        lockup.alphaValue = NSWorkspace.shared.accessibilityDisplayShouldReduceMotion ? 1 : 0
        pendingOpeningLockup = lockup
        startOpeningIfVisible()
    }

    func applicationDidBecomeActive(_ notification: Notification) {
        startOpeningIfVisible()
    }

    func windowDidChangeOcclusionState(_ notification: Notification) {
        startOpeningIfVisible()
    }

    private func startOpeningIfVisible() {
        guard let lockup = pendingOpeningLockup, let overlay = openingOverlay,
              NSApp.isActive, window.isVisible, window.occlusionState.contains(.visible) else { return }
        pendingOpeningLockup = nil
        overlay.layoutSubtreeIfNeeded()
        let reduceMotion = NSWorkspace.shared.accessibilityDisplayShouldReduceMotion
        if !reduceMotion {
            animateOpeningBrand(lockup, appearing: true)
        }
        lockup.alphaValue = 1
        // Keep the reveal on its existing schedule so the clear mark stays visible longer.
        let timeBeforeExit: TimeInterval = reduceMotion ? 1 : 1.3
        DispatchQueue.main.asyncAfter(deadline: .now() + timeBeforeExit) {
            guard self.openingOverlay === overlay else { return }
            self.openingWaitingForReveal = lockup
            self.revealWorkbenchIfReady()
        }
    }

    private func animateOpeningBrand(_ lockup: NSStackView, appearing: Bool) {
        guard let layer = lockup.layer else { return }
        let scale: CGFloat = 0.76
        var small = CATransform3DMakeScale(scale, scale, 1)
        // Scale around the visual center with AppKit's current layer anchor.
        small.m41 = layer.bounds.width * (0.5 - layer.anchorPoint.x) * (1 - scale)
        small.m42 = layer.bounds.height * (0.5 - layer.anchorPoint.y) * (1 - scale)
        let resize = CABasicAnimation(keyPath: "transform")
        resize.fromValue = NSValue(caTransform3D: appearing ? small : CATransform3DIdentity)
        resize.toValue = NSValue(caTransform3D: appearing ? CATransform3DIdentity : small)
        var effects = [resize]
        if let blur = CIFilter(name: "CIGaussianBlur") {
            blur.name = "openingBlur"
            blur.setValue(0, forKey: kCIInputRadiusKey)
            layer.filters = [blur]
            let focus = CABasicAnimation(keyPath: "filters.openingBlur.inputRadius")
            focus.fromValue = appearing ? 10 : 0
            focus.toValue = appearing ? 0 : 10
            effects.append(focus)
        }
        for effect in effects {
            effect.duration = openingMarkDuration
            effect.timingFunction = CAMediaTimingFunction(name: .easeOut)
            layer.add(effect, forKey: effect.keyPath)
        }
    }

    private func revealWorkbenchIfReady() {
        guard let lockup = openingWaitingForReveal, ready,
              let overlay = openingOverlay, let backdrop = openingBackdrop else { return }
        openingWaitingForReveal = nil
        guard !NSWorkspace.shared.accessibilityDisplayShouldReduceMotion else {
            overlay.removeFromSuperview()
            return
        }

        let tailOverlap: TimeInterval = 0.08
        animateOpeningBrand(lockup, appearing: false)
        NSAnimationContext.runAnimationGroup { animation in
            animation.duration = openingMarkDuration
            animation.timingFunction = CAMediaTimingFunction(name: .easeInEaseOut)
            lockup.animator().alphaValue = 0
        } completionHandler: {
            lockup.isHidden = true
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + (openingMarkDuration - tailOverlap)) {
            guard self.openingOverlay === overlay else { return }
            self.fadeInWorkbench(behind: backdrop, overlay: overlay)
        }
    }

    private func fadeInWorkbench(behind backdrop: NSBox, overlay: NSView) {
        let duration: TimeInterval = 1
        let focusDocument = """
        document.documentElement.animate(
            [{ filter: 'blur(8px)' }, { filter: 'blur(0px)' }],
            { duration: \(duration * 1000), easing: 'ease-in-out' }
        );
        void 0;
        """
        web.evaluateJavaScript(focusDocument, completionHandler: nil)
        NSAnimationContext.runAnimationGroup { animation in
            animation.duration = duration
            animation.timingFunction = CAMediaTimingFunction(controlPoints: 0.32, 0.16, 0.6, 1)
            backdrop.animator().alphaValue = 0
        } completionHandler: {
            overlay.removeFromSuperview()
        }
    }

    // Read the original device deltas before WebKit scroll latching or axis filtering.
    // Leave the event in AppKit's normal path for the document, menus and inspector.
    private func observeChartScroll() {
        scrollMonitor = NSEvent.addLocalMonitorForEvents(matching: [.scrollWheel, .swipe]) { [weak self] event in
            guard let self, self.ready, self.forwardDeviceScroll else { return event }
            if event.window === self.window || (event.window == nil && NSApp.keyWindow === self.window) {
                self.forwardChartScroll(event)
            }
            return event
        }
    }

    private func forwardChartScroll(_ event: NSEvent) {
        let swipe = event.type == .swipe
        let shift = event.modifierFlags.contains(.shift)
        // WebKit still owns magnification and Control-wheel zoom.
        guard !event.modifierFlags.contains(.control) else { return }
        var phase = ""
        let dx: CGFloat, dy: CGFloat
        if swipe {
            guard event.deltaX != 0 && abs(event.deltaX) >= abs(event.deltaY) else { return }
            dx = -event.deltaX
            dy = 0
            phase = "swipe"
        } else {
            if event.momentumPhase.contains(.began) { phase = "momentum" }
            else if !event.momentumPhase.intersection([.ended, .cancelled]).isEmpty { phase = "end" }
            else if event.phase.contains(.began) { phase = "begin" }
            else if event.phase.contains(.ended) { phase = "lift" }
            else if event.phase.contains(.cancelled) { phase = "end" }
            let scale: CGFloat = event.hasPreciseScrollingDeltas ? 1 : 16
            dx = -event.scrollingDeltaX * scale
            dy = -event.scrollingDeltaY * scale
            guard dx != 0 || dy != 0 || !phase.isEmpty else { return }
        }
        let location = event.window == nil ? window.convertPoint(fromScreen: NSEvent.mouseLocation) : event.locationInWindow
        let point = web.convert(location, from: nil), bounds = web.bounds
        guard bounds.width > 0, bounds.height > 0 else { return }
        let x = (point.x - bounds.minX) / bounds.width
        let y = (point.y - bounds.minY) / bounds.height
        scrollSamples.append(["x": x, "y": web.isFlipped ? y : 1 - y, "dx": dx / web.pageZoom, "dy": dy / web.pageZoom, "shift": shift, "phase": phase])
        sendScrollBatch()
    }

    // Bound IPC to one pending call. Each ordered batch is painted in one animation frame.
    private func sendScrollBatch() {
        guard !sendingScroll, !scrollSamples.isEmpty else { return }
        sendingScroll = true
        let samples = scrollSamples
        scrollSamples.removeAll(keepingCapacity: true)
        web.callAsyncJavaScript("window.workbenchScrollSamples(samples); return true", arguments: ["samples": samples], in: nil, in: .page) { [weak self] result in
            guard let self else { return }
            self.sendingScroll = false
            if case .failure = result {
                self.forwardDeviceScroll = false
                self.scrollSamples.removeAll()
                self.web.evaluateJavaScript("window.studioNativeScroll = false")
                return
            }
            self.sendScrollBatch()
        }
    }

    func applicationWillTerminate(_ notification: Notification) {
        if let scrollMonitor { NSEvent.removeMonitor(scrollMonitor) }
        if let zoomMonitor { NSEvent.removeMonitor(zoomMonitor) }
    }

    private func observeZoomKeys() {
        zoomMonitor = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { [weak self] event in
            guard let self, self.ready, NSApp.keyWindow === self.window,
                  event.modifierFlags.intersection([.command, .control, .option]) == .command
            else { return event }
            switch event.charactersIgnoringModifiers {
            case "+", "=": self.zoomIn()
            case "-": self.zoomOut()
            case "0": self.resetZoom()
            default: return event
            }
            return nil
        }
    }

    private func setInterfaceZoom(_ percent: Int) {
        guard ready, percent != zoomPercent else { return }
        zoomPercent = percent
        UserDefaults.standard.set(percent, forKey: zoomPreference)
        web.evaluateJavaScript("window.setWorkbenchZoom(\(percent))")
        web.pageZoom = CGFloat(percent) / 100
    }

    @objc private func zoomIn() {
        if let next = zoomSteps.first(where: { $0 > zoomPercent }) { setInterfaceZoom(next) }
    }

    @objc private func zoomOut() {
        if let next = zoomSteps.last(where: { $0 < zoomPercent }) { setInterfaceZoom(next) }
    }

    @objc private func resetZoom() { setInterfaceZoom(100) }

    private let tools: [(id: String, label: String, symbol: String, control: String)] = [
        ("manuscript", "修改剧本", "square.and.pencil", "openWriting"),
        ("history", "剧本历史", "clock.arrow.circlepath", "openHistory"),
        ("import", "导入稿件", "square.and.arrow.down", "importBtn"),
        ("save", "保存草稿", "square.and.arrow.down.on.square", "saveBtn"),
        ("export", "导出", "square.and.arrow.up", "exportBtn")
    ]
    func toolbarDefaultItemIdentifiers(_ toolbar: NSToolbar) -> [NSToolbarItem.Identifier] {
        [.init("manuscript"), .init("history"), .flexibleSpace, .init("import"), .init("save"), .init("export"), appearanceToolID]
    }
    func toolbarAllowedItemIdentifiers(_ toolbar: NSToolbar) -> [NSToolbarItem.Identifier] {
        toolbarDefaultItemIdentifiers(toolbar)
    }
    func toolbar(_ toolbar: NSToolbar, itemForItemIdentifier identifier: NSToolbarItem.Identifier, willBeInsertedIntoToolbar flag: Bool) -> NSToolbarItem? {
        if identifier == appearanceToolID {
            let item = NSToolbarItem(itemIdentifier: identifier)
            item.paletteLabel = "切换浅色和深色"
            item.target = self
            item.action = #selector(toggleAppearance)
            updateAppearanceTool(item)
            if flag { appearanceTool = item }
            return item
        }
        guard let tool = tools.first(where: { $0.id == identifier.rawValue }) else { return nil }
        let item = NSToolbarItem(itemIdentifier: identifier)
        item.label = tool.label
        item.paletteLabel = tool.label
        item.toolTip = tool.label
        item.image = NSImage(systemSymbolName: tool.symbol, accessibilityDescription: tool.label)
        item.target = self
        item.action = #selector(useTool(_:))
        return item
    }

    private func updateAppearanceTool(_ item: NSToolbarItem) {
        let target = nextAppearance
        let title = "切换为\(target.title)模式"
        item.label = title
        item.toolTip = title
        item.image = NSImage(systemSymbolName: target == .light ? "sun.max" : "moon", accessibilityDescription: title)
    }

    @objc private func toggleAppearance() {
        applyAppearance(nextAppearance)
    }

    @objc func useTool(_ sender: NSToolbarItem) {
        guard ready, let tool = tools.first(where: { $0.id == sender.itemIdentifier.rawValue }) else { return }
        web.evaluateJavaScript("if(!document.querySelector('dialog[open]')) document.getElementById('\(tool.control)').click()")
    }

    func buildMenu() {
        let bar = NSMenu()
        func menu(_ name: String) -> NSMenu {
            let item = NSMenuItem()
            bar.addItem(item)
            let menu = NSMenu(title: name)
            item.submenu = menu
            return menu
        }
        let app = menu("子牧曲镜工作台")
        app.addItem(withTitle: "关于子牧曲镜工作台", action: #selector(NSApplication.orderFrontStandardAboutPanel(_:)), keyEquivalent: "")
        app.addItem(.separator())
        app.addItem(withTitle: "退出子牧曲镜工作台", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        let file = menu("文件")
        file.addItem(withTitle: "导入稿件…", action: #selector(importFile), keyEquivalent: "o").target = self
        file.addItem(withTitle: "为当前镜头选取分镜图…", action: #selector(chooseStoryboardImage), keyEquivalent: "").target = self
        file.addItem(withTitle: "剧本历史…", action: #selector(openHistory), keyEquivalent: "").target = self
        file.addItem(withTitle: "保存草稿", action: #selector(save), keyEquivalent: "s").target = self
        file.addItem(withTitle: "关闭窗口", action: #selector(NSWindow.performClose(_:)), keyEquivalent: "w")
        let edit = menu("编辑")
        for (title, action, key) in [("撤销","undo:","z"),("重做","redo:","Z"),("剪切","cut:","x"),("复制","copy:","c"),("粘贴","paste:","v"),("全选","selectAll:","a")] {
            let paste = action == "paste:"
            let item = edit.addItem(withTitle: title, action: paste ? #selector(pasteInWorkbench(_:)) : NSSelectorFromString(action), keyEquivalent: key)
            if paste { item.target = self }
        }
        let view = menu("显示")
        view.addItem(withTitle: "重播开屏动画", action: #selector(showOpening), keyEquivalent: "").target = self
        view.addItem(.separator())
        let appearanceItem = view.addItem(withTitle: "外观", action: nil, keyEquivalent: "")
        appearanceItem.submenu = appearanceMenu
        for mode in WorkbenchAppearance.allCases {
            let item = appearanceMenu.addItem(withTitle: mode.title, action: #selector(selectAppearance(_:)), keyEquivalent: "")
            item.target = self
            item.representedObject = mode.rawValue
            item.state = mode == appearanceMode ? .on : .off
        }
        view.addItem(.separator())
        view.addItem(withTitle: "放大界面", action: #selector(zoomIn), keyEquivalent: "+").target = self
        view.addItem(withTitle: "缩小界面", action: #selector(zoomOut), keyEquivalent: "-").target = self
        view.addItem(withTitle: "恢复实际大小", action: #selector(resetZoom), keyEquivalent: "0").target = self
        NSApp.mainMenu = bar
    }

    @objc private func selectAppearance(_ sender: NSMenuItem) {
        guard let value = sender.representedObject as? String, let mode = WorkbenchAppearance(rawValue: value) else { return }
        applyAppearance(mode)
    }

    private func applyAppearance(_ mode: WorkbenchAppearance) {
        guard mode != appearanceMode else { return }
        appearanceMode = mode
        UserDefaults.standard.set(mode.rawValue, forKey: appearanceKey)
        for item in appearanceMenu.items {
            item.state = item.representedObject as? String == mode.rawValue ? .on : .off
        }
        appearanceChange += 1
        let change = appearanceChange
        appearanceSnapshots.forEach { $0.removeFromSuperview() }
        appearanceSnapshots.removeAll()

        guard ready, openingOverlay == nil, window.occlusionState.contains(.visible),
              !NSWorkspace.shared.accessibilityDisplayShouldReduceMotion else {
            updateLiveAppearance()
            return
        }

        web.takeSnapshot(with: nil) { [weak self] image, _ in
            guard let self, self.appearanceChange == change else { return }
            guard let image, let content = self.window.contentView, self.openingOverlay == nil else {
                self.updateLiveAppearance()
                return
            }

            var snapshots: [AppearanceSnapshotView] = []
            if let titlebar = self.captureTitlebar(above: content) {
                snapshots.append(titlebar)
            }
            let page = AppearanceSnapshotView(frame: self.web.frame)
            page.image = image
            page.imageScaling = .scaleAxesIndependently
            page.autoresizingMask = [.width, .height]
            page.wantsLayer = true
            content.addSubview(page, positioned: .above, relativeTo: self.web)
            snapshots.append(page)
            self.appearanceSnapshots = snapshots

            // Fade the original toolbar and page together over the live window.
            self.updateLiveAppearance { [weak self] in
                guard let self, self.appearanceChange == change else { return }
                NSAnimationContext.runAnimationGroup { animation in
                    animation.duration = 0.5
                    animation.timingFunction = CAMediaTimingFunction(name: .easeInEaseOut)
                    snapshots.forEach { $0.animator().alphaValue = 0 }
                } completionHandler: { [weak self] in
                    snapshots.forEach { $0.removeFromSuperview() }
                    if self?.appearanceChange == change { self?.appearanceSnapshots.removeAll() }
                }
            }
        }
    }

    private func captureTitlebar(above content: NSView) -> AppearanceSnapshotView? {
        var frameView = content
        while let parent = frameView.superview { frameView = parent }
        let bounds = frameView.bounds
        let pageFrame = content.convert(content.bounds, to: frameView)
        let titlebarStart = frameView.isFlipped ? bounds.minY : pageFrame.maxY
        let titlebarEnd = frameView.isFlipped ? pageFrame.minY : bounds.maxY
        let rect = NSRect(x: bounds.minX, y: titlebarStart, width: bounds.width,
                          height: titlebarEnd - titlebarStart)
        guard rect.height > 0, let bitmap = frameView.bitmapImageRepForCachingDisplay(in: rect) else { return nil }

        frameView.cacheDisplay(in: rect, to: bitmap)
        let image = NSImage(size: rect.size)
        image.addRepresentation(bitmap)
        let snapshot = AppearanceSnapshotView(frame: rect)
        snapshot.image = image
        snapshot.imageScaling = .scaleAxesIndependently
        snapshot.autoresizingMask = [.width, frameView.isFlipped ? .maxYMargin : .minYMargin]
        snapshot.wantsLayer = true
        window.effectiveAppearance.performAsCurrentDrawingAppearance {
            snapshot.layer?.backgroundColor = window.backgroundColor.cgColor
        }
        frameView.addSubview(snapshot, positioned: .above, relativeTo: nil)
        return snapshot
    }

    private func updateLiveAppearance(completion: (() -> Void)? = nil) {
        NSApp.appearance = appearanceMode.nativeAppearance
        if let item = appearanceTool { updateAppearanceTool(item) }
        if ready {
            web.evaluateJavaScript("window.setWorkbenchAppearance('\(appearanceMode.rawValue)')") { _, _ in completion?() }
        }
    }

    @objc func importFile() { web.evaluateJavaScript("if(!document.querySelector('dialog[open]'))document.getElementById('importBtn').click()") }
    @objc private func chooseStoryboardImage() {
        if ready { web.evaluateJavaScript("window.chooseStoryboardImage()") }
    }

    private let imageFileOptions: [NSPasteboard.ReadingOptionKey: Any] = [
        .urlReadingFileURLsOnly: true, .urlReadingContentsConformToTypes: [UTType.image.identifier]
    ]
    private let bitmapTypes: [NSPasteboard.PasteboardType] = [.png, .tiff, .init(UTType.jpeg.identifier)]

    @objc private func pasteInWorkbench(_ sender: Any?) {
        let pasteNormally = { NSApp.sendAction(NSSelectorFromString("paste:"), to: nil, from: sender) }
        let board = NSPasteboard.general
        guard ready, NSApp.keyWindow === window, window.attachedSheet == nil,
              board.availableType(from: bitmapTypes) != nil || board.canReadObject(forClasses: [NSURL.self], options: imageFileOptions)
        else { _ = pasteNormally(); return }
        web.evaluateJavaScript("window.pasteIntoShotGallery()") { result, _ in
            if result as? Bool != true { _ = pasteNormally() }
        }
    }
    @objc func openHistory() { web.evaluateJavaScript("if(!document.querySelector('dialog[open]'))document.getElementById('openHistory').click()") }
    @objc func save() { web.evaluateJavaScript("document.getElementById('saveBtn').click()") }
    func windowShouldClose(_ sender: NSWindow) -> Bool { NSApp.terminate(nil); return false }

    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        guard ready else { return .terminateNow }
        if quitting { return .terminateLater }
        quitting = true
        web.callAsyncJavaScript("return await window.flushWorkbenchDraft()", arguments: [:], in: nil, in: .page) { result in
            self.quitting = false
            if case .success(let value) = result, value as? Bool == true {
                sender.reply(toApplicationShouldTerminate: true)
            } else {
                let alert = NSAlert()
                alert.messageText = "草稿保存失败"
                alert.informativeText = "可以返回工作台导出项目JSON，保留当前修改。"
                alert.addButton(withTitle: "返回工作台")
                alert.addButton(withTitle: "放弃未保存修改并退出")
                sender.reply(toApplicationShouldTerminate: alert.runModal() == .alertSecondButtonReturn)
            }
        }
        return .terminateLater
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        webView.evaluateJavaScript("window.setWorkbenchAppearance('\(appearanceMode.rawValue)')")
        webView.pageZoom = CGFloat(zoomPercent) / 100
        ready = true
        forwardDeviceScroll = true
        revealWorkbenchIfReady()
    }
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        reportNavigationFailure(error)
    }
    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        reportNavigationFailure(error)
    }
    private func reportNavigationFailure(_ error: Error) {
        openingOverlay?.removeFromSuperview()
        openingOverlay = nil
        openingWaitingForReveal = nil
        describeError(error)
    }
    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        let url = action.request.url
        decisionHandler(action.targetFrame?.isMainFrame == true && url?.isFileURL == true && url?.standardizedFileURL.path == page.path ? .allow : .cancel)
    }
    func webView(_ webView: WKWebView, runOpenPanelWith parameters: WKOpenPanelParameters, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping ([URL]?) -> Void) {
        let panel = NSOpenPanel()
        panel.allowsMultipleSelection = parameters.allowsMultipleSelection
        panel.canChooseDirectories = false
        panel.beginSheetModal(for: window) { response in
            if response == .OK {
                self.importDocument = panel.urls.first { ["md", "txt", "markdown", "json"].contains($0.pathExtension.lowercased()) }
            }
            completionHandler(response == .OK ? panel.urls : nil)
        }
    }
    func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (Bool) -> Void) {
        let alert = NSAlert()
        alert.messageText = message
        alert.addButton(withTitle: "继续")
        alert.addButton(withTitle: "取消")
        alert.beginSheetModal(for: window) { completionHandler($0 == .alertFirstButtonReturn) }
    }
    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage, replyHandler: @escaping (Any?, String?) -> Void) {
        guard message.frameInfo.isMainFrame, message.frameInfo.request.url?.standardizedFileURL.path == page.path,
              let body = message.body as? [String: Any], let op = body["op"] as? String else { replyHandler(nil, "请求无效"); return }
        do {
            switch op {
            case "chooseStoryboard":
                let panel = NSOpenPanel()
                panel.allowedContentTypes = [.image]
                let limit = min(4, max(1, body["limit"] as? Int ?? 4))
                panel.allowsMultipleSelection = limit > 1
                panel.prompt = "添加"
                panel.beginSheetModal(for: window) { response in
                    guard response == .OK else { replyHandler(nil, nil); return }
                    self.storyboardImages.add(panel.urls.map(StoryboardImages.Input.file), limit: limit, reply: replyHandler)
                }
            case "pasteStoryboard":
                let board = NSPasteboard.general
                let limit = min(4, max(1, body["limit"] as? Int ?? 4))
                let urls = board.readObjects(forClasses: [NSURL.self], options: imageFileOptions) as? [URL] ?? []
                var inputs = urls.map(StoryboardImages.Input.file)
                if inputs.isEmpty {
                    for item in board.pasteboardItems ?? [] {
                        guard let type = item.availableType(from: bitmapTypes), let bytes = item.data(forType: type) else { continue }
                        inputs.append(.pixels(bytes))
                        if inputs.count >= limit { break }
                    }
                }
                storyboardImages.add(inputs, limit: limit, reply: replyHandler)
            case "importStoryboard":
                guard let ref = body["path"] as? String, let source = importDocument,
                      body["document"] as? String == source.lastPathComponent,
                      ["md", "txt", "markdown", "json"].contains(source.pathExtension.lowercased())
                else { throw CocoaError(.fileReadNoPermission) }
                storyboardImages.process({ try self.storyboardImages.importedPath(ref, nextTo: source) }, reply: replyHandler)
            case "storeStoryboard":
                guard let encoded = body["bytes"] as? String else { throw CocoaError(.fileReadCorruptFile) }
                let key = body["key"] as? String
                storyboardImages.process({
                    if let key { return try self.storyboardImages.restore(encoded, key: key) }
                    guard let data = Data(base64Encoded: encoded) else { throw CocoaError(.fileReadCorruptFile) }
                    return try self.storyboardImages.preview(bytes: data)
                }, reply: replyHandler)
            case "exportStoryboard":
                guard let key = body["key"] as? String else { throw CocoaError(.fileReadCorruptFile) }
                storyboardImages.process({ try self.storyboardImages.export(key) }, reply: replyHandler)
            case "hasStoryboard":
                guard let key = body["key"] as? String else { throw CocoaError(.fileReadCorruptFile) }
                storyboardImages.process({ try self.storyboardImages.isAvailable(key) }, reply: replyHandler)
            case "exportBoardPackage":
                guard let name = body["name"] as? String, let manuscript = body["manuscript"] as? String,
                      let images = body["images"] as? [[String: String]] else { throw CocoaError(.fileWriteUnknown) }
                let panel = NSSavePanel()
                panel.allowedContentTypes = [.zip]
                panel.nameFieldStringValue = name.replacingOccurrences(of: "/", with: "-")
                panel.beginSheetModal(for: window) { response in
                    guard response == .OK, let url = panel.url else { replyHandler(false, nil); return }
                    self.storyboardImages.process({
                        try self.storyboardImages.exportPackage(manuscript: manuscript, images: images, to: url)
                        return true
                    }, reply: replyHandler)
                }
            case "save":
                guard let id = body["id"] as? String, let raw = body["entry"] as? String,
                      let entry = try JSONSerialization.jsonObject(with: Data(raw.utf8)) as? [String: Any],
                      let project = entry["data"] as? [String: Any], project["format"] as? String == "shot-curves-v1" else { throw CocoaError(.fileReadCorruptFile) }
                var drafts = library["drafts"] as? [String: Any] ?? [:]
                drafts[id] = entry
                let updated: [String: Any] = ["active": id, "drafts": drafts]
                try JSONSerialization.data(withJSONObject: updated).write(to: store, options: .atomic)
                library = updated
                replyHandler(true, nil)
            case "activateDraft":
                guard let id = body["id"] as? String,
                      let drafts = library["drafts"] as? [String: Any], drafts[id] != nil else { throw CocoaError(.fileNoSuchFile) }
                var updated = library
                updated["active"] = id
                try JSONSerialization.data(withJSONObject: updated).write(to: store, options: .atomic)
                library = updated
                replyHandler(true, nil)
            case "copy":
                guard let text = body["text"] as? String else { throw CocoaError(.fileReadCorruptFile) }
                NSPasteboard.general.clearContents()
                replyHandler(NSPasteboard.general.setString(text, forType: .string), nil)
            case "export":
                guard let name = body["name"] as? String, let text = body["text"] as? String else { throw CocoaError(.fileWriteUnknown) }
                let panel = NSSavePanel()
                panel.nameFieldStringValue = name.replacingOccurrences(of: "/", with: "-")
                panel.beginSheetModal(for: window) { response in
                    guard response == .OK, let url = panel.url else { replyHandler(false, nil); return }
                    do { try text.write(to: url, atomically: true, encoding: .utf8); replyHandler(true, nil) }
                    catch { replyHandler(nil, error.localizedDescription) }
                }
            default: replyHandler(nil, "未知请求")
            }
        } catch { replyHandler(nil, error.localizedDescription) }
    }
}

let app = NSApplication.shared
let studio = Studio()
app.setActivationPolicy(.regular)
app.delegate = studio
app.run()
