import AppKit

let width = 1200
let height = 630
let root = URL(fileURLWithPath: FileManager.default.currentDirectoryPath)
let screenshotURL = root.appendingPathComponent("apps/landing/assets/agent-manager-ui.png")
let iconURL = root.appendingPathComponent("apps/landing/assets/app-icon.png")
let outputURL = root.appendingPathComponent("apps/landing/assets/og.png")

guard
    let screenshot = NSImage(contentsOf: screenshotURL),
    let icon = NSImage(contentsOf: iconURL),
    let bitmap = NSBitmapImageRep(
        bitmapDataPlanes: nil,
        pixelsWide: width,
        pixelsHigh: height,
        bitsPerSample: 8,
        samplesPerPixel: 4,
        hasAlpha: true,
        isPlanar: false,
        colorSpaceName: .deviceRGB,
        bytesPerRow: 0,
        bitsPerPixel: 0
    )
else {
    fatalError("Could not load OG source assets")
}

NSGraphicsContext.saveGraphicsState()
guard let context = NSGraphicsContext(bitmapImageRep: bitmap) else {
    fatalError("Could not create graphics context")
}
NSGraphicsContext.current = context
context.imageInterpolation = .high

let canvas = NSRect(x: 0, y: 0, width: width, height: height)
let gradient = NSGradient(colors: [
    NSColor(calibratedRed: 0.965, green: 0.980, blue: 0.992, alpha: 1),
    NSColor(calibratedRed: 0.902, green: 0.936, blue: 0.964, alpha: 1)
])!
gradient.draw(in: canvas, angle: -12)

NSColor(calibratedWhite: 1, alpha: 0.48).setFill()
NSBezierPath(ovalIn: NSRect(x: -120, y: 280, width: 650, height: 500)).fill()
NSColor(calibratedRed: 0.51, green: 0.77, blue: 0.93, alpha: 0.13).setFill()
NSBezierPath(ovalIn: NSRect(x: 770, y: -170, width: 600, height: 600)).fill()

let productCard = NSBezierPath(roundedRect: NSRect(x: 532, y: 40, width: 630, height: 550), xRadius: 34, yRadius: 34)
NSGraphicsContext.saveGraphicsState()
let shadow = NSShadow()
shadow.shadowColor = NSColor(calibratedRed: 0.12, green: 0.20, blue: 0.28, alpha: 0.18)
shadow.shadowBlurRadius = 32
shadow.shadowOffset = NSSize(width: 0, height: -10)
shadow.set()
NSColor(calibratedWhite: 1, alpha: 0.74).setFill()
productCard.fill()
NSGraphicsContext.restoreGraphicsState()

NSColor(calibratedWhite: 1, alpha: 0.72).setStroke()
productCard.lineWidth = 1
productCard.stroke()

icon.draw(
    in: NSRect(x: 72, y: 454, width: 86, height: 86),
    from: .zero,
    operation: .sourceOver,
    fraction: 1
)

let paragraph = NSMutableParagraphStyle()
paragraph.alignment = .left
paragraph.lineBreakMode = .byWordWrapping

let titleAttributes: [NSAttributedString.Key: Any] = [
    .font: NSFont.systemFont(ofSize: 68, weight: .bold),
    .foregroundColor: NSColor(calibratedRed: 0.055, green: 0.075, blue: 0.095, alpha: 1),
    .paragraphStyle: paragraph,
    .kern: -2.2
]
("Agent Micro" as NSString).draw(
    in: NSRect(x: 70, y: 340, width: 445, height: 90),
    withAttributes: titleAttributes
)

let taglineAttributes: [NSAttributedString.Key: Any] = [
    .font: NSFont.systemFont(ofSize: 37, weight: .medium),
    .foregroundColor: NSColor(calibratedRed: 0.18, green: 0.23, blue: 0.28, alpha: 1),
    .paragraphStyle: paragraph,
    .kern: -0.8
]
("Run six agents.\nKeep main clean." as NSString).draw(
    in: NSRect(x: 72, y: 208, width: 420, height: 104),
    withAttributes: taglineAttributes
)

let badgeRect = NSRect(x: 72, y: 128, width: 239, height: 43)
NSColor(calibratedRed: 0.05, green: 0.075, blue: 0.095, alpha: 1).setFill()
NSBezierPath(roundedRect: badgeRect, xRadius: 21.5, yRadius: 21.5).fill()
let badgeAttributes: [NSAttributedString.Key: Any] = [
    .font: NSFont.systemFont(ofSize: 15, weight: .semibold),
    .foregroundColor: NSColor.white,
    .kern: 0.3
]
("OPEN SOURCE · macOS" as NSString).draw(
    in: NSRect(x: 92, y: 140, width: 207, height: 22),
    withAttributes: badgeAttributes
)

screenshot.draw(
    in: NSRect(x: 550, y: 57, width: 596, height: 463),
    from: .zero,
    operation: .sourceOver,
    fraction: 1
)

NSGraphicsContext.restoreGraphicsState()

guard let png = bitmap.representation(using: .png, properties: [:]) else {
    fatalError("Could not encode OG image")
}
try png.write(to: outputURL)
print("Wrote \(outputURL.path)")
