type PageTextTranslation = {
  sourceText: string
  translatedText: string
}

type PageRuntimeMessage = {
  type: 'open-translate:start-page-translator'
  maxNodes: number
  pageTranslationScope: 'visible-page' | 'viewport'
  translationProvider: 'openai-compatible' | 'chrome-built-in'
  targetLanguage: string
  displayMode: 'translation' | 'bilingual'
  userWhitelist: string[]
  translationConcurrency: number
  translationBatchSegments: number
  translationBatchTextLength: number
}

type PartialTranslationMessage = {
  type: 'open-translate:partial-page-translations'
  requestId: string
  displayMode: 'translation' | 'bilingual'
  translations: Array<{
    index: number
    text: string
  }>
}

const runtimeWindow = window as typeof window & {
  __openTranslatePageRuntimeInstalled?: boolean
  __openTranslatePartialTranslationHandler?: (message: PartialTranslationMessage) => void
}

if (!runtimeWindow.__openTranslatePageRuntimeInstalled) {
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (isPartialTranslationMessage(message)) {
      runtimeWindow.__openTranslatePartialTranslationHandler?.(message)
      return false
    }

    if (!isStartPageTranslatorMessage(message)) {
      return false
    }

    sendResponse(installPageTranslator(
      message.maxNodes,
      message.pageTranslationScope,
      message.translationProvider,
      message.targetLanguage,
      message.displayMode,
      message.userWhitelist,
      message.translationConcurrency,
      message.translationBatchSegments,
      message.translationBatchTextLength,
    ))
    return false
  })
  runtimeWindow.__openTranslatePageRuntimeInstalled = true
}

function isPartialTranslationMessage(message: unknown): message is PartialTranslationMessage {
  return (
    !!message &&
    typeof message === 'object' &&
    (message as PartialTranslationMessage).type ===
      'open-translate:partial-page-translations' &&
    typeof (message as PartialTranslationMessage).requestId === 'string' &&
    Array.isArray((message as PartialTranslationMessage).translations)
  )
}

function isStartPageTranslatorMessage(message: unknown): message is PageRuntimeMessage {
  return (
    !!message &&
    typeof message === 'object' &&
    (message as PageRuntimeMessage).type === 'open-translate:start-page-translator' &&
    typeof (message as PageRuntimeMessage).maxNodes === 'number' &&
    (
      (message as PageRuntimeMessage).pageTranslationScope === 'visible-page' ||
      (message as PageRuntimeMessage).pageTranslationScope === 'viewport'
    ) &&
    (
      (message as PageRuntimeMessage).translationProvider === 'openai-compatible' ||
      (message as PageRuntimeMessage).translationProvider === 'chrome-built-in'
    ) &&
    typeof (message as PageRuntimeMessage).targetLanguage === 'string' &&
    (
      (message as PageRuntimeMessage).displayMode === 'translation' ||
      (message as PageRuntimeMessage).displayMode === 'bilingual'
    ) &&
    Array.isArray((message as PageRuntimeMessage).userWhitelist) &&
    typeof (message as PageRuntimeMessage).translationConcurrency === 'number' &&
    typeof (message as PageRuntimeMessage).translationBatchSegments === 'number' &&
    typeof (message as PageRuntimeMessage).translationBatchTextLength === 'number'
  )
}

function installPageTranslator(
  maxNodes: number,
  pageTranslationScope: 'visible-page' | 'viewport',
  translationProvider: 'openai-compatible' | 'chrome-built-in',
  targetLanguage: string,
  displayMode: 'translation' | 'bilingual',
  userWhitelist: string[],
  translationConcurrency: number,
  translationBatchSegments: number,
  translationBatchTextLength: number,
) {
  type PageTranslatorState = {
    observer: MutationObserver
    removeScrollListener?: () => void
  }
  type PageTranslationResponse = {
    translations?: string[]
    displayMode?: 'translation' | 'bilingual'
    error?: string
  }

  const windowWithTranslator = window as typeof window & {
    __openTranslatePageTranslator?: PageTranslatorState
    __openTranslatePageSessionId?: number
    __openTranslatePageOriginals?: Map<Text, PageTextTranslation>
    __openTranslatePageTranslations?: Set<string>
  }
  windowWithTranslator.__openTranslatePageTranslator?.observer.disconnect()
  windowWithTranslator.__openTranslatePageTranslator?.removeScrollListener?.()
  const pageSessionId = beginPageTranslationSession(windowWithTranslator)

  const ignoredTags = new Set([
    'SCRIPT',
    'STYLE',
    'NOSCRIPT',
    'IFRAME',
    'SVG',
    'CANVAS',
    'PRE',
    'CODE',
    'TEXTAREA',
    'INPUT',
    'SELECT',
    'OPTION',
  ])
  const state = {
    pendingNodes: new Set<Text>(),
    inFlightNodes: new Set<Text>(),
    translationRequests: new Map<string, { nodes: Text[]; sourceTexts: string[] }>(),
    builtInTranslators: new Map<string, Promise<BuiltInTranslator>>(),
    builtInLanguageDetector: undefined as Promise<BuiltInLanguageDetector | undefined> | undefined,
    isApplyingTranslation: false,
    debounceTimer: 0,
  }
  runtimeWindow.__openTranslatePartialTranslationHandler = applyPartialTranslations

  const observer = new MutationObserver((mutations) => {
    if (state.isApplyingTranslation) {
      return
    }

    for (const mutation of mutations) {
      if (mutation.type === 'characterData' && mutation.target.nodeType === Node.TEXT_NODE) {
        enqueueTextNode(mutation.target as Text)
      }

      for (const node of mutation.addedNodes) {
        collectTextNodes(node)
      }
    }

    scheduleFlush()
  })

  observer.observe(document.body, {
    childList: true,
    characterData: true,
    subtree: true,
  })

  const handleScroll = () => {
    scheduleViewportFlush()
  }
  if (pageTranslationScope === 'viewport') {
    window.addEventListener('scroll', handleScroll, { passive: true })
  }

  windowWithTranslator.__openTranslatePageTranslator = {
    observer,
    removeScrollListener:
      pageTranslationScope === 'viewport'
        ? () => window.removeEventListener('scroll', handleScroll)
        : undefined,
  }
  collectTextNodes(document.body)
  const initialNodes = takePendingNodes()
  if (!initialNodes.length) {
    return { collected: false }
  }

  void requestTranslations(initialNodes, initialNodes.map((node) => node.nodeValue || ''))
    .then(notifyInitialTranslationComplete)
    .catch(notifyPageTranslationError)
  return { collected: true }

  function collectTextNodes(node: Node) {
    if (state.pendingNodes.size >= maxNodes) {
      return
    }

    if (node.nodeType === Node.TEXT_NODE) {
      enqueueTextNode(node as Text)
      return
    }

    if (!(node instanceof Element) || ignoredTags.has(node.tagName)) {
      return
    }

    if (node.closest('[data-open-translate-ui], [data-open-translate-bilingual]')) {
      return
    }

    const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT, {
      acceptNode(textNode) {
        return isTranslatableTextNode(textNode as Text)
          ? NodeFilter.FILTER_ACCEPT
          : NodeFilter.FILTER_REJECT
      },
    })

    while (state.pendingNodes.size < maxNodes) {
      const textNode = walker.nextNode()
      if (!textNode) {
        break
      }

      enqueueTextNode(textNode as Text)
    }
  }

  function enqueueTextNode(node: Text) {
    if (!state.inFlightNodes.has(node) && isTranslatableTextNode(node)) {
      state.pendingNodes.add(node)
    }
  }

  function scheduleFlush() {
    window.clearTimeout(state.debounceTimer)
    state.debounceTimer = window.setTimeout(flushPendingNodes, 650)
  }

  function scheduleViewportFlush() {
    window.clearTimeout(state.debounceTimer)
    state.debounceTimer = window.setTimeout(() => {
      collectTextNodes(document.body)
      flushPendingNodes()
    }, 220)
  }

  function flushPendingNodes() {
    const nodes = takePendingNodes()
    if (!nodes.length) {
      return
    }

    const sourceTexts = nodes.map((node) => node.nodeValue || '')
    void requestTranslations(nodes, sourceTexts).catch(notifyPageTranslationError)
  }

  function takePendingNodes() {
    const nodes = [...state.pendingNodes]
      .filter((node) => !state.inFlightNodes.has(node) && isTranslatableTextNode(node))
      .slice(0, maxNodes)
    state.pendingNodes.clear()

    for (const node of nodes) {
      state.inFlightNodes.add(node)
    }

    return nodes
  }

  function requestTranslations(nodes: Text[], sourceTexts: string[]) {
    if (translationProvider === 'chrome-built-in') {
      return requestBuiltInTranslations(nodes, sourceTexts)
    }

    const requestId = createTranslationRequestId()
    state.translationRequests.set(requestId, { nodes, sourceTexts })

    return new Promise<void>((resolve) => {
      chrome.runtime.sendMessage(
        { type: 'open-translate:translate-texts', requestId, texts: sourceTexts },
        (response) => {
          const pageTranslationResponse = response as PageTranslationResponse | undefined
          try {
            if (!isUsablePageTranslationResponse(pageTranslationResponse)) {
              return
            }

            applyPageTranslations(nodes, sourceTexts, pageTranslationResponse)
          } finally {
            state.translationRequests.delete(requestId)
            releaseInFlightNodes(nodes)
            resolve()
          }
        },
      )
    })
  }

  async function requestBuiltInTranslations(nodes: Text[], sourceTexts: string[]) {
    const entries = sourceTexts.map((sourceText, index) => ({ index, sourceText }))
      .filter((entry) => (
        entry.sourceText.trim() &&
        !userWhitelist.includes(entry.sourceText.trim())
      ))
    let completed = sourceTexts.length - entries.length

    try {
      await notifyPageTranslationProgress(completed, sourceTexts.length)
      await runConcurrent(
        createBuiltInTranslationBatches(
          entries,
          translationBatchSegments,
          translationBatchTextLength,
        ),
        translationConcurrency,
        async (batch) => {
          const translatedEntries: Array<{
            node?: Text
            sourceText?: string
            translatedText?: string
          }> = []

          for (const entry of batch) {
            translatedEntries.push({
              node: nodes[entry.index],
              sourceText: entry.sourceText,
              translatedText: await translateWithBuiltInAI(entry.sourceText),
            })
          }

          applyPageTranslationEntries(translatedEntries, displayMode)
          completed += batch.length
          await notifyPageTranslationProgress(completed, sourceTexts.length)
        },
      )
    } finally {
      releaseInFlightNodes(nodes)
    }
  }

  async function translateWithBuiltInAI(sourceText: string) {
    const sourceLanguage = await detectBuiltInSourceLanguage(sourceText)
    const targetLanguageCode = normalizeBuiltInTargetLanguageCode(targetLanguage)
    if (sourceLanguage === targetLanguageCode) {
      return sourceText
    }

    const translator = await getBuiltInTranslator(sourceLanguage, targetLanguageCode)
    return translator.translate(sourceText)
  }

  function normalizeBuiltInTargetLanguageCode(language: string) {
    const normalized = language.trim()
    const alias = new Map<string, string>([
      ['简体中文', 'zh'],
      ['中文', 'zh'],
      ['繁体中文', 'zh-Hant'],
      ['英文', 'en'],
      ['英语', 'en'],
      ['日文', 'ja'],
      ['日语', 'ja'],
      ['韩文', 'ko'],
      ['韩语', 'ko'],
      ['simplified chinese', 'zh'],
      ['chinese', 'zh'],
      ['traditional chinese', 'zh-Hant'],
      ['english', 'en'],
      ['japanese', 'ja'],
      ['korean', 'ko'],
    ]).get(normalized.toLowerCase())

    return alias || normalized || 'zh'
  }

  async function getBuiltInTranslator(sourceLanguage: string, targetLanguageCode: string) {
    const apiWindow = window as Window & {
      Translator?: BuiltInTranslatorConstructor
    }
    if (!apiWindow.Translator) {
      throw new Error('Chrome Built-in AI Translator is not available')
    }

    const cacheKey = `${sourceLanguage}:${targetLanguageCode}`
    const existingTranslator = state.builtInTranslators.get(cacheKey)
    if (existingTranslator) {
      return existingTranslator
    }

    const translatorPromise = apiWindow.Translator.availability({
      sourceLanguage,
      targetLanguage: targetLanguageCode,
    }).then((availability) => {
      if (availability === 'unavailable') {
        throw new Error('Chrome Built-in AI Translator does not support this language pair')
      }

      return apiWindow.Translator!.create({
        sourceLanguage,
        targetLanguage: targetLanguageCode,
      })
    })

    state.builtInTranslators.set(cacheKey, translatorPromise)
    return translatorPromise
  }

  async function detectBuiltInSourceLanguage(sourceText: string) {
    const documentLanguage = normalizeBuiltInSourceLanguageCode(
      document.documentElement.lang || navigator.language || 'en',
    )
    if (sourceText.trim().length < 20) {
      return documentLanguage
    }

    const detector = await getBuiltInLanguageDetector()
    if (!detector) {
      return documentLanguage
    }

    try {
      const [result] = await detector.detect(sourceText)
      return result?.confidence > 0.55
        ? normalizeBuiltInSourceLanguageCode(result.detectedLanguage)
        : documentLanguage
    } catch {
      return documentLanguage
    }
  }

  async function getBuiltInLanguageDetector() {
    const apiWindow = window as Window & {
      LanguageDetector?: BuiltInLanguageDetectorConstructor
    }
    if (!apiWindow.LanguageDetector) {
      return undefined
    }

    state.builtInLanguageDetector ||= apiWindow.LanguageDetector.availability()
      .then((availability) => {
        if (availability === 'unavailable') {
          return undefined
        }

        return apiWindow.LanguageDetector!.create()
      })
      .catch(() => undefined)

    return state.builtInLanguageDetector
  }

  function normalizeBuiltInSourceLanguageCode(language: string) {
    const normalized = language.trim() || 'en'
    if (/^zh-(tw|hk|mo|hant)/i.test(normalized)) {
      return 'zh-Hant'
    }
    if (/^zh/i.test(normalized)) {
      return 'zh'
    }

    return normalized.split('-')[0].toLowerCase()
  }

  async function runConcurrent<T>(
    items: T[],
    concurrency: number,
    worker: (item: T) => Promise<void>,
  ) {
    let nextIndex = 0

    async function runWorker() {
      while (nextIndex < items.length) {
        const item = items[nextIndex]
        nextIndex += 1
        await worker(item)
      }
    }

    await Promise.all(
      Array.from({ length: Math.min(Math.max(1, concurrency), items.length) }, () => runWorker()),
    )
  }

  function createBuiltInTranslationBatches<T extends { sourceText: string }>(
    entries: T[],
    maxBatchSegments: number,
    maxBatchTextLength: number,
  ) {
    const batches: T[][] = []
    let batch: T[] = []
    let batchTextLength = 0

    for (const entry of entries) {
      const nextTextLength = batchTextLength + entry.sourceText.length
      if (
        batch.length &&
        (batch.length >= maxBatchSegments || nextTextLength > maxBatchTextLength)
      ) {
        batches.push(batch)
        batch = []
        batchTextLength = 0
      }

      batch.push(entry)
      batchTextLength += entry.sourceText.length
    }

    if (batch.length) {
      batches.push(batch)
    }

    return batches
  }

  function applyPartialTranslations(message: PartialTranslationMessage) {
    const request = state.translationRequests.get(message.requestId)
    if (!request || windowWithTranslator.__openTranslatePageSessionId !== pageSessionId) {
      return
    }

    applyPageTranslationEntries(
      message.translations.map((translation) => ({
        node: request.nodes[translation.index],
        sourceText: request.sourceTexts[translation.index],
        translatedText: translation.text,
      })),
      message.displayMode,
    )
  }

  function isUsablePageTranslationResponse(
    response?: PageTranslationResponse,
  ): response is PageTranslationResponse {
    return !(
      chrome.runtime.lastError ||
      response?.error ||
      !response?.translations ||
      windowWithTranslator.__openTranslatePageSessionId !== pageSessionId
    )
  }

  function applyPageTranslations(
    nodes: Text[],
    sourceTexts: string[],
    response: PageTranslationResponse,
  ) {
    applyPageTranslationEntries(
      nodes.map((node, index) => ({
        node,
        sourceText: sourceTexts[index],
        translatedText: response.translations?.[index],
      })),
      response.displayMode || 'translation',
    )
  }

  function applyPageTranslationEntries(
    entries: Array<{
      node?: Text
      sourceText?: string
      translatedText?: string
    }>,
    displayMode: 'translation' | 'bilingual',
  ) {
    state.isApplyingTranslation = true
    try {
      for (const entry of entries) {
        if (
          !entry.node ||
          !entry.sourceText ||
          !canApplyPageTranslation(entry.node, entry.sourceText, entry.translatedText)
        ) {
          continue
        }

        applyPageTranslation(
          entry.node,
          entry.sourceText,
          entry.translatedText,
          displayMode,
        )
      }
    } finally {
      window.setTimeout(() => {
        state.isApplyingTranslation = false
      }, 0)
    }
  }

  function canApplyPageTranslation(
    node: Text,
    sourceText: string,
    translatedText?: string,
  ): translatedText is string {
    return !!(
      translatedText &&
      node.parentNode &&
      node.nodeValue === sourceText &&
      isTranslatableTextNode(node)
    )
  }

  function releaseInFlightNodes(nodes: Text[]) {
    for (const node of nodes) {
      state.inFlightNodes.delete(node)
    }
  }

  function applyPageTranslation(
    node: Text,
    sourceText: string,
    translatedText: string,
    displayMode: 'translation' | 'bilingual',
  ) {
    const pageWindow = window as typeof window & {
      __openTranslatePageOriginals?: Map<Text, PageTextTranslation>
      __openTranslatePageTranslations?: Set<string>
    }
    const originals =
      pageWindow.__openTranslatePageOriginals || new Map<Text, PageTextTranslation>()
    const translatedTexts = pageWindow.__openTranslatePageTranslations || new Set<string>()
    pageWindow.__openTranslatePageOriginals = originals
    pageWindow.__openTranslatePageTranslations = translatedTexts
    originals.set(node, { sourceText, translatedText })
    translatedTexts.add(translatedText)

    const nextSibling = node.nextSibling
    if (
      nextSibling instanceof HTMLElement &&
      nextSibling.dataset.openTranslateBilingual === 'true'
    ) {
      nextSibling.remove()
    }

    if (displayMode === 'translation') {
      node.nodeValue = translatedText
      return
    }

    node.nodeValue = sourceText
    node.parentNode?.insertBefore(createPageBilingualText(translatedText), node.nextSibling)
  }

  function createPageBilingualText(translatedText: string) {
    const wrapper = document.createElement('font')
    wrapper.dataset.openTranslateBilingual = 'true'
    wrapper.textContent = translatedText
    wrapper.style.cssText = `
      display: inline;
      margin-left: 0.35em;
    `

    return wrapper
  }

  function isTranslatableTextNode(node: Text) {
    const parent = node.parentElement
    const text = node.nodeValue || ''
    const existingTranslation = windowWithTranslator.__openTranslatePageOriginals?.get(node)

    if (!parent || ignoredTags.has(parent.tagName)) {
      return false
    }

    if (
      existingTranslation &&
      (
        text === existingTranslation.translatedText ||
        (
          text === existingTranslation.sourceText &&
          node.nextSibling instanceof HTMLElement &&
          node.nextSibling.dataset.openTranslateBilingual === 'true'
        )
      )
    ) {
      return false
    }

    if (windowWithTranslator.__openTranslatePageTranslations?.has(text)) {
      return false
    }

    if (
      parent.closest(
        "pre, code, [contenteditable='true'], [data-open-translate-ui], [data-open-translate-selection-panel], [data-open-translate-bilingual]",
      )
    ) {
      return false
    }

    if (!text.trim() || /^[\d\s()[\]{}.,:;'"!?+\-*/\\|_=<>@#$%^&~`]+$/.test(text.trim())) {
      return false
    }

    const rect = parent.getBoundingClientRect()
    const style = getComputedStyle(parent)
    return (
      rect.width > 0 &&
      rect.height > 0 &&
      (pageTranslationScope !== 'viewport' || isRectInViewport(rect)) &&
      style.visibility !== 'hidden' &&
      style.display !== 'none' &&
      Number(style.opacity) !== 0
    )
  }

  function isRectInViewport(rect: DOMRect) {
    return (
      rect.bottom > 0 &&
      rect.right > 0 &&
      rect.top < window.innerHeight &&
      rect.left < window.innerWidth
    )
  }

  function notifyInitialTranslationComplete() {
    chrome.runtime.sendMessage({ type: 'open-translate:initial-page-translation-complete' })
  }

  function notifyPageTranslationProgress(completed: number, total: number) {
    return chrome.runtime.sendMessage({
      type: 'open-translate:page-translation-progress',
      completed,
      total,
    })
  }

  function notifyPageTranslationError(error: unknown) {
    chrome.runtime.sendMessage({
      type: 'open-translate:page-translation-error',
      message: error instanceof Error ? error.message : String(error),
    })
  }

  function createTranslationRequestId() {
    return `page-${pageSessionId}-${Date.now()}-${Math.random().toString(16).slice(2)}`
  }
}

function beginPageTranslationSession(
  pageWindow: typeof window & {
    __openTranslatePageOriginals?: Map<Text, PageTextTranslation>
    __openTranslatePageSessionId?: number
    __openTranslatePageTranslations?: Set<string>
  },
) {
  const pageSessionId = (pageWindow.__openTranslatePageSessionId || 0) + 1

  pageWindow.__openTranslatePageSessionId = pageSessionId
  pageWindow.__openTranslatePageOriginals = new Map<Text, PageTextTranslation>()
  pageWindow.__openTranslatePageTranslations = new Set<string>()
  return pageSessionId
}
