import Foundation
import Vision
import ImageIO

struct Block: Codable { let text: String; let confidence: Float; let x: Double; let y: Double; let width: Double; let height: Double }
struct Output: Codable { let text: String; let blocks: [Block] }
do {
    let input = FileHandle.standardInput.readDataToEndOfFile()
    guard input.count < 20_000_000, let source = CGImageSourceCreateWithData(input as CFData, nil), let image = CGImageSourceCreateImageAtIndex(source, 0, nil) else { throw NSError(domain:"OCR",code:1,userInfo:[NSLocalizedDescriptionKey:"Invalid PNG/JPEG input"]) }
    let request = VNRecognizeTextRequest()
    request.recognitionLevel = .accurate
    request.recognitionLanguages = ["zh-Hans", "en-US"]
    request.usesLanguageCorrection = false
    try VNImageRequestHandler(cgImage:image,options:[:]).perform([request])
    let blocks = (request.results ?? []).compactMap { observation -> Block? in
        guard let candidate = observation.topCandidates(1).first else { return nil }
        let b = observation.boundingBox
        return Block(text:candidate.string,confidence:candidate.confidence,x:b.origin.x,y:1-b.origin.y-b.height,width:b.width,height:b.height)
    }
    let output = Output(text:blocks.map{$0.text}.joined(separator:"\n"),blocks:blocks)
    FileHandle.standardOutput.write(try JSONEncoder().encode(output))
} catch {
    FileHandle.standardError.write(Data(error.localizedDescription.utf8)); exit(1)
}
