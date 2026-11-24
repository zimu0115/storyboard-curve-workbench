#!/bin/bash
set -euo pipefail
src="$(cd "$(dirname "$0")" && pwd)"
root="$(dirname "$src")"
app="${1:-$root/子牧曲镜工作台.app}/Contents"
mkdir -p "$app/MacOS" "$app/Resources"
xcrun swiftc -O -target "$(uname -m)-apple-macos13" "$src/main.swift" "$src/StoryboardImages.swift" -o "$app/MacOS/StoryboardStudio"
cp "$src/Info.plist" "$app/Info.plist"
artwork=$(mktemp -d)
trap 'rm -r "$artwork"' EXIT
mkdir "$artwork/Workbench.iconset"
xcrun swift "$src/render_brand.swift" "$src/Workbench.icns" "$src/BrandBadge.png" "$artwork/Workbench.iconset"
/usr/bin/iconutil -c icns "$artwork/Workbench.iconset" -o "$app/Resources/Workbench.icns"
cp "$artwork/Workbench.iconset/icon_128x128@2x.png" "$app/Resources/WorkbenchMark.png"
python3 "$src/bundle_page.py" "$app/Resources/分镜曲线工作台.html"
ditto "$root/工作台资源" "$app/Resources/工作台资源"
/usr/bin/codesign --force --sign - --identifier studio.zimu.storyboardcurves.opensource "$(dirname "$app")"
