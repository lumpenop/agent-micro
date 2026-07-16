import Foundation
import Speech
import AVFoundation

guard CommandLine.arguments.count >= 2 else {
  fputs("usage: macos-transcribe <audio-file> [locale]\n", stderr)
  exit(2)
}

let path = CommandLine.arguments[1]
let localeId = CommandLine.arguments.count >= 3 ? CommandLine.arguments[2] : "ko-KR"
let url = URL(fileURLWithPath: path)
let locale = Locale(identifier: localeId)

guard FileManager.default.fileExists(atPath: path) else {
  fputs("file-not-found\n", stderr)
  exit(2)
}

guard let recognizer = SFSpeechRecognizer(locale: locale) else {
  fputs("recognizer-unavailable\n", stderr)
  exit(2)
}

if !recognizer.isAvailable {
  fputs("recognizer-not-available\n", stderr)
  exit(2)
}

let semaphore = DispatchSemaphore(value: 0)
var outText = ""
var errText = ""

SFSpeechRecognizer.requestAuthorization { status in
  guard status == .authorized else {
    errText = "speech-not-authorized"
    semaphore.signal()
    return
  }

  let request = SFSpeechURLRecognitionRequest(url: url)
  request.shouldReportPartialResults = false
  if #available(macOS 13.0, *) {
    request.requiresOnDeviceRecognition = false // allow Apple servers OR on-device
  }

  recognizer.recognitionTask(with: request) { result, error in
    if let error = error {
      errText = error.localizedDescription
      semaphore.signal()
      return
    }
    guard let result = result else { return }
    outText = result.bestTranscription.formattedString
    if result.isFinal {
      semaphore.signal()
    }
  }
}

let wait = semaphore.wait(timeout: .now() + 45)
if wait == .timedOut {
  fputs("timeout\n", stderr)
  exit(1)
}
if !errText.isEmpty {
  fputs(errText + "\n", stderr)
  exit(1)
}
if outText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
  fputs("empty\n", stderr)
  exit(1)
}
print(outText)
