// ENZO macOS app shell — the .app's actual CFBundleExecutable.
//
// A bash/node process cannot answer the Dock's quit AppleEvent (tested:
// "AppleEvent timed out" and the app kept running), so this ~50-line
// AppKit shell IS the app process: it shows the Dock icon, spawns the
// bundled node launcher as its child, and relays Dock → Quit / Cmd-Q to
// the launcher as SIGTERM (the launcher forwards it to the server and
// waits for a clean exit before itself exiting).
//
// If the launcher dies on its own (server crash), the app quits with it —
// a dead server must never leave an unkillable-looking Dock icon.
//
// Compiled at package time: swiftc -O main.swift -o ENZO.app/Contents/MacOS/ENZO
// (needs Xcode Command Line Tools on the BUILD machine only — users get a
// finished binary).

import AppKit

final class AppDelegate: NSObject, NSApplicationDelegate {
    private var child: Process?

    func applicationDidFinishLaunching(_ notification: Notification) {
        guard let resources = Bundle.main.resourcePath else { NSApp.terminate(nil); return }
        let node = resources + "/node-runtime/bin/node"
        let launcher = resources + "/app/launcher.js"

        let process = Process()
        process.executableURL = URL(fileURLWithPath: node)
        process.arguments = [launcher]
        process.standardOutput = FileHandle.standardOutput
        process.standardError = FileHandle.standardError
        do {
            try process.run()
        } catch {
            NSApp.terminate(nil)
            return
        }
        child = process
        process.terminationHandler = { [weak self] _ in
            self?.child = nil
            NSApp.terminate(nil)
        }
    }

    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        guard let child, child.isRunning else { return .terminateNow }
        child.interrupt() // SIGTERM — the launcher's shutdown path
        let deadline = Date().addingTimeInterval(8)
        while child.isRunning && Date() < deadline {
            RunLoop.current.run(until: Date().addingTimeInterval(0.1))
        }
        if child.isRunning { child.terminate() } // SIGKILL fallback
        return .terminateNow
    }
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.regular) // visible in the Dock, Cmd-Q works when active
app.run()
