// DESC: Read the text shown in images with macOS's Vision OCR: one JSON line per image, offline.
//
// watch-reel.zsh compiles this once (into $DATA_DIR/bin) and runs it on a pack's distinct frames,
// so a tool name, URL or @handle that a reel only shows on screen ends up in onscreen.txt.
//
// Usage: read-frame-text <image>...
// Prints {"file": "<path>", "lines": ["…", …]} per image, top to bottom; an unreadable image prints
// {"file": …, "error": "…"} and the run carries on.

import Foundation
import Vision

func emit(_ obj: [String: Any]) {
    if let data = try? JSONSerialization.data(withJSONObject: obj, options: []),
       let s = String(data: data, encoding: .utf8) {
        print(s)
    }
}

for path in CommandLine.arguments.dropFirst() {
    let url = URL(fileURLWithPath: path)
    guard let src = CGImageSourceCreateWithURL(url as CFURL, nil),
          let image = CGImageSourceCreateImageAtIndex(src, 0, nil) else {
        emit(["file": path, "error": "cannot read the image"])
        continue
    }
    let request = VNRecognizeTextRequest()
    request.recognitionLevel = .accurate
    // Reels mix English and Turkish; correction would "fix" handles and URLs into words.
    request.recognitionLanguages = ["en-US", "tr-TR"]
    request.usesLanguageCorrection = false
    do {
        try VNImageRequestHandler(cgImage: image, options: [:]).perform([request])
    } catch {
        emit(["file": path, "error": "\(error)"])
        continue
    }
    // Vision's origin is bottom left: sort by descending y for reading order, then by x.
    let obs = (request.results ?? []).sorted {
        abs($0.boundingBox.midY - $1.boundingBox.midY) > 0.02
            ? $0.boundingBox.midY > $1.boundingBox.midY
            : $0.boundingBox.minX < $1.boundingBox.minX
    }
    let lines = obs.compactMap { o -> String? in
        guard let top = o.topCandidates(1).first, top.confidence >= 0.4 else { return nil }
        return top.string
    }
    emit(["file": path, "lines": lines])
}
