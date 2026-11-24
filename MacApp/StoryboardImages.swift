import CryptoKit
import Foundation
import ImageIO
import UniformTypeIdentifiers
import WebKit

// Drafts keep only the image key. Both preview sizes read the same local artwork.
final class StoryboardImages: NSObject, WKURLSchemeHandler {
    enum Input {
        case file(URL)
        case pixels(Data)
    }

    let directory: URL
    private let queue = DispatchQueue(label: "studio.zimu.storyboard-images", qos: .userInitiated)
    private let rasterTypes: [UTType] = [.png, .jpeg, .tiff, .gif, .bmp, .heic, .heif, .webP] + [UTType(filenameExtension: "avif")].compactMap { $0 }

    init(directory: URL) { self.directory = directory }

    func process(_ work: @escaping () throws -> Any, reply: @escaping (Any?, String?) -> Void) {
        queue.async {
            do {
                let value = try autoreleasepool(invoking: work)
                DispatchQueue.main.async { reply(value, nil) }
            } catch {
                DispatchQueue.main.async { reply(nil, error.localizedDescription) }
            }
        }
    }

    private func imageURL(_ key: String) throws -> URL {
        guard key.utf8.count == 64, key.utf8.allSatisfy({ (48...57).contains($0) || (97...102).contains($0) })
        else { throw CocoaError(.fileReadCorruptFile) }
        return directory.appendingPathComponent(key + ".jpg")
    }

    private func store(_ data: Data, expected: String? = nil) throws -> String {
        let key = SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
        guard expected == nil || expected == key else { throw CocoaError(.fileReadCorruptFile) }
        let url = try imageURL(key)
        if !FileManager.default.fileExists(atPath: url.path) {
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
            try data.write(to: url, options: .atomic)
        }
        return key
    }

    func preview(file: URL) throws -> String {
        let props = try file.resourceValues(forKeys: [.isRegularFileKey])
        guard props.isRegularFile == true, let source = CGImageSourceCreateWithURL(file as CFURL, nil)
        else { throw CocoaError(.fileReadUnknown) }
        return try preview(source)
    }

    func preview(bytes: Data) throws -> String {
        guard let source = CGImageSourceCreateWithData(bytes as CFData, nil) else { throw CocoaError(.fileReadCorruptFile) }
        return try preview(source)
    }

    func add(_ inputs: [Input], limit: Int, reply: @escaping (Any?, String?) -> Void) {
        process({
            var keys: [String] = []
            var failures = 0
            for input in inputs.prefix(limit) {
                do {
                    let key = try autoreleasepool {
                        switch input {
                        case .file(let url): return try self.preview(file: url)
                        case .pixels(let bytes): return try self.preview(bytes: bytes)
                        }
                    }
                    keys.append(key)
                } catch { failures += 1 }
            }
            return ["keys": keys, "failed": failures, "excess": max(0, inputs.count - limit)]
        }, reply: reply)
    }

    private func preview(_ source: CGImageSource) throws -> String {
        guard let raw = CGImageSourceGetType(source), let type = UTType(raw as String),
              rasterTypes.contains(where: { type.conforms(to: $0) }) else { throw CocoaError(.fileReadCorruptFile) }
        let options: [CFString: Any] = [kCGImageSourceCreateThumbnailFromImageAlways: true,
                                       kCGImageSourceCreateThumbnailWithTransform: true,
                                       kCGImageSourceThumbnailMaxPixelSize: 1200]
        guard let image = CGImageSourceCreateThumbnailAtIndex(source, 0, options as CFDictionary)
        else { throw CocoaError(.fileReadCorruptFile) }
        let data = NSMutableData()
        guard let writer = CGImageDestinationCreateWithData(data, UTType.jpeg.identifier as CFString, 1, nil)
        else { throw CocoaError(.fileWriteUnknown) }
        CGImageDestinationAddImage(writer, image, [kCGImageDestinationLossyCompressionQuality: 0.86,
                                                   kCGImageDestinationBackgroundColor: CGColor(gray: 1, alpha: 1)] as CFDictionary)
        guard CGImageDestinationFinalize(writer) else { throw CocoaError(.fileWriteUnknown) }
        return try store(data as Data)
    }

    func importedPath(_ path: String, nextTo document: URL) throws -> String {
        let root = document.deletingLastPathComponent().resolvingSymlinksInPath().standardizedFileURL
        let decoded = path.removingPercentEncoding ?? path
        guard !decoded.hasPrefix("/"), !decoded.hasPrefix("~"), URL(string: decoded)?.scheme == nil
        else { throw CocoaError(.fileReadNoPermission) }
        let file = root.appendingPathComponent(decoded).standardizedFileURL.resolvingSymlinksInPath()
        guard file.path.hasPrefix(root.path + "/"), rasterTypes.contains(where: { UTType(filenameExtension: file.pathExtension)?.conforms(to: $0) == true })
        else { throw CocoaError(.fileReadNoPermission) }
        return try preview(file: file)
    }

    func restore(_ encoded: String, key: String) throws -> String {
        _ = try imageURL(key)
        guard let data = Data(base64Encoded: encoded), let source = CGImageSourceCreateWithData(data as CFData, nil),
              CGImageSourceGetType(source) as String? == UTType.jpeg.identifier
        else { throw CocoaError(.fileReadCorruptFile) }
        return try store(data, expected: key)
    }

    func export(_ key: String) throws -> String {
        try Data(contentsOf: imageURL(key)).base64EncodedString()
    }

    func isAvailable(_ key: String) throws -> Bool {
        FileManager.default.isReadableFile(atPath: try imageURL(key).path)
    }

    func exportPackage(manuscript: String, images: [[String: String]], to destination: URL) throws {
        let files = FileManager.default
        let temp = try files.url(for: .itemReplacementDirectory, in: .userDomainMask,
                                 appropriateFor: destination, create: true)
        defer { try? files.removeItem(at: temp) }
        let contents = temp.appendingPathComponent("内容", isDirectory: true)
        try files.createDirectory(at: contents, withIntermediateDirectories: false)
        try manuscript.write(to: contents.appendingPathComponent("分镜稿.md"), atomically: false, encoding: .utf8)
        let gallery = contents.appendingPathComponent("分镜图", isDirectory: true)
        if !images.isEmpty { try files.createDirectory(at: gallery, withIntermediateDirectories: false) }
        for item in images {
            guard let key = item["key"], let name = item["name"],
                  name.range(of: #"\A(?:镜[0-9]+[A-Za-z]?(?:-序[0-9]+)?|序[0-9]+)-0[1-4]\.jpg\z"#,
                             options: .regularExpression) != nil else { throw CocoaError(.fileWriteInvalidFileName) }
            try files.copyItem(at: imageURL(key), to: gallery.appendingPathComponent(name))
        }
        let archive = temp.appendingPathComponent("图文.zip")
        let pack = Process()
        pack.executableURL = URL(fileURLWithPath: "/usr/bin/ditto")
        pack.arguments = ["-c", "-k", "--norsrc", "--noextattr", "--noacl", contents.path, archive.path]
        try pack.run()
        pack.waitUntilExit()
        guard pack.terminationStatus == 0 else { throw CocoaError(.fileWriteUnknown) }
        if files.fileExists(atPath: destination.path) {
            _ = try files.replaceItemAt(destination, withItemAt: archive)
        } else {
            try files.moveItem(at: archive, to: destination)
        }
    }

    func webView(_ webView: WKWebView, start task: WKURLSchemeTask) {
        do {
            guard let url = task.request.url, url.host == "local", url.pathComponents.count == 2
            else { throw CocoaError(.fileReadNoPermission) }
            let data = try Data(contentsOf: imageURL(url.lastPathComponent), options: .mappedIfSafe)
            task.didReceive(URLResponse(url: url, mimeType: "image/jpeg", expectedContentLength: data.count, textEncodingName: nil))
            task.didReceive(data)
            task.didFinish()
        } catch { task.didFailWithError(error) }
    }

    func webView(_ webView: WKWebView, stop task: WKURLSchemeTask) {}
}
