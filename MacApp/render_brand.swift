import AppKit
import ImageIO
import UniformTypeIdentifiers

// Compose the badge over the existing curve mark in a 1024-point design space.
func loadImage(_ path: String) throws -> CGImage {
    let url = URL(fileURLWithPath: path)
    guard let source = CGImageSourceCreateWithURL(url as CFURL, nil) else { throw CocoaError(.fileReadCorruptFile) }
    let images = (0..<CGImageSourceGetCount(source)).compactMap { CGImageSourceCreateImageAtIndex(source, $0, nil) }
    guard let largest = images.max(by: { $0.width < $1.width }) else { throw CocoaError(.fileReadCorruptFile) }
    return largest
}

let curve = try loadImage(CommandLine.arguments[1])
let symbol = try loadImage(CommandLine.arguments[2])
let output = URL(fileURLWithPath: CommandLine.arguments[3], isDirectory: true)
let space = CGColorSpace(name: CGColorSpace.sRGB)!
let badgeWidth: CGFloat = 192
let badgeHeight = badgeWidth * CGFloat(symbol.height) / CGFloat(symbol.width)
let cornerInset: CGFloat = 216
let badge = CGRect(x: 1024 - cornerInset - badgeWidth, y: cornerInset,
                   width: badgeWidth, height: badgeHeight)
let r = badgeHeight * 0.08
let path = CGMutablePath()
path.move(to: CGPoint(x: badge.minX, y: badge.minY))
path.addArc(tangent1End: CGPoint(x: badge.maxX, y: badge.minY),
            tangent2End: CGPoint(x: badge.maxX, y: badge.maxY), radius: r)
path.addLine(to: CGPoint(x: badge.maxX, y: badge.maxY))
path.addArc(tangent1End: CGPoint(x: badge.minX, y: badge.maxY),
            tangent2End: CGPoint(x: badge.minX, y: badge.minY), radius: r)
path.closeSubpath()

for points in [16, 32, 128, 256, 512] {
    for scale in [1, 2] {
        let pixels = points * scale
        guard let ctx = CGContext(data: nil, width: pixels, height: pixels, bitsPerComponent: 8,
                                  bytesPerRow: 0, space: space, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)
        else { throw CocoaError(.fileWriteUnknown) }
        let ratio = CGFloat(pixels) / 1024
        ctx.scaleBy(x: ratio, y: ratio)
        ctx.interpolationQuality = .high
        ctx.draw(curve, in: CGRect(x: 0, y: 0, width: 1024, height: 1024))
        ctx.addPath(path)
        ctx.clip()
        ctx.beginTransparencyLayer(auxiliaryInfo: nil)
        ctx.draw(symbol, in: badge)
        ctx.setBlendMode(.sourceIn)
        ctx.setFillColor(CGColor(gray: 1, alpha: 1))
        ctx.fill(badge)
        ctx.endTransparencyLayer()
        let suffix = scale == 2 ? "@2x" : ""
        let url = output.appendingPathComponent("icon_\(points)x\(points)\(suffix).png")
        guard let png = CGImageDestinationCreateWithURL(url as CFURL, UTType.png.identifier as CFString, 1, nil),
              let image = ctx.makeImage() else { throw CocoaError(.fileWriteUnknown) }
        CGImageDestinationAddImage(png, image, nil)
        guard CGImageDestinationFinalize(png) else { throw CocoaError(.fileWriteUnknown) }
    }
}
