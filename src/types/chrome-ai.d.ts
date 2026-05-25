type BuiltInAIAvailability = 'available' | 'downloadable' | 'downloading' | 'unavailable'

type BuiltInAIMonitor = EventTarget & {
  addEventListener(
    type: 'downloadprogress',
    listener: (event: ProgressEvent) => void,
  ): void
}

type BuiltInTranslator = {
  translate(text: string): Promise<string>
}

type BuiltInLanguageDetector = {
  detect(text: string): Promise<Array<{
    detectedLanguage: string
    confidence: number
  }>>
}

type BuiltInTranslatorConstructor = {
  availability(options: {
    sourceLanguage: string
    targetLanguage: string
  }): Promise<BuiltInAIAvailability>
  create(options: {
    sourceLanguage: string
    targetLanguage: string
    monitor?: (monitor: BuiltInAIMonitor) => void
  }): Promise<BuiltInTranslator>
}

type BuiltInLanguageDetectorConstructor = {
  availability(): Promise<BuiltInAIAvailability>
  create(options?: {
    monitor?: (monitor: BuiltInAIMonitor) => void
  }): Promise<BuiltInLanguageDetector>
}

interface Window {
  Translator?: BuiltInTranslatorConstructor
  LanguageDetector?: BuiltInLanguageDetectorConstructor
}

interface WorkerGlobalScope {
  Translator?: BuiltInTranslatorConstructor
  LanguageDetector?: BuiltInLanguageDetectorConstructor
}
