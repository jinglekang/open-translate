type PageTextTranslation = {
  sourceText: string
  translatedText: string
}

type PageElementTranslation = {
  sourceText: string
  translatedText: string
  originalHtml: string
}

type PageTranslationUnit = TextTranslationUnit | ElementTranslationUnit

type TextTranslationUnit = {
  kind: 'text'
  node: Text
  sourceText: string
}

type ElementTranslationUnit = {
  kind: 'element'
  element: Element
  sourceText: string
  originalHtml: string
  fragments: ProtectedFragment[]
}

type ProtectedFragment = {
  token: string
  node: Node
}

type PageRuntimeMessage = {
  type: 'open-translate:start-page-translator'
  maxNodes: number
  translationScope: 'visible-page' | 'viewport'
  translationProvider: 'openai-compatible' | 'chrome-built-in'
  targetLanguageCode: string
  displayMode: 'translation' | 'bilingual'
  translationMode: 'text-node' | 'element-context'
  userWhitelist: string[]
  noTranslateSelectors: string[]
  minTranslationTextLength: number
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
      message.translationScope,
      message.translationProvider,
      message.targetLanguageCode,
      message.displayMode,
      message.translationMode,
      message.userWhitelist,
      message.noTranslateSelectors,
      message.minTranslationTextLength,
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
      (message as PageRuntimeMessage).translationScope === 'visible-page' ||
      (message as PageRuntimeMessage).translationScope === 'viewport'
    ) &&
    (
      (message as PageRuntimeMessage).translationProvider === 'openai-compatible' ||
      (message as PageRuntimeMessage).translationProvider === 'chrome-built-in'
    ) &&
    typeof (message as PageRuntimeMessage).targetLanguageCode === 'string' &&
    (
      (message as PageRuntimeMessage).displayMode === 'translation' ||
      (message as PageRuntimeMessage).displayMode === 'bilingual'
    ) &&
    (
      (message as PageRuntimeMessage).translationMode === 'text-node' ||
      (message as PageRuntimeMessage).translationMode === 'element-context'
    ) &&
    Array.isArray((message as PageRuntimeMessage).userWhitelist) &&
    Array.isArray((message as PageRuntimeMessage).noTranslateSelectors) &&
    typeof (message as PageRuntimeMessage).minTranslationTextLength === 'number' &&
    typeof (message as PageRuntimeMessage).translationConcurrency === 'number' &&
    typeof (message as PageRuntimeMessage).translationBatchSegments === 'number' &&
    typeof (message as PageRuntimeMessage).translationBatchTextLength === 'number'
  )
}

function installPageTranslator(
  maxNodes: number,
  translationScope: 'visible-page' | 'viewport',
  translationProvider: 'openai-compatible' | 'chrome-built-in',
  targetLanguageCode: string,
  displayMode: 'translation' | 'bilingual',
  translationMode: 'text-node' | 'element-context',
  userWhitelist: string[],
  noTranslateSelectors: string[],
  minTranslationTextLength: number,
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
    __openTranslatePageElementOriginals?: Map<Element, PageElementTranslation>
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
    'TEXTAREA',
    'INPUT',
    'SELECT',
    'OPTION',
  ])
  const state = {
    pendingNodes: new Set<Text>(),
    inFlightNodes: new Set<Text>(),
    inFlightElements: new Set<Element>(),
    translationRequests: new Map<string, { units: PageTranslationUnit[] }>(),
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
  if (translationScope === 'viewport') {
    window.addEventListener('scroll', handleScroll, { passive: true })
  }

  windowWithTranslator.__openTranslatePageTranslator = {
    observer,
    removeScrollListener:
      translationScope === 'viewport'
        ? () => window.removeEventListener('scroll', handleScroll)
        : undefined,
  }
  collectTextNodes(document.body)
  const initialUnits = takePendingUnits()
  if (!initialUnits.length) {
    return { collected: false }
  }

  void requestTranslations(initialUnits)
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
    if (
      !state.inFlightNodes.has(node) &&
      !isInsideInFlightElement(node) &&
      isTranslatableTextNode(node)
    ) {
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
    const units = takePendingUnits()
    if (!units.length) {
      return
    }

    void requestTranslations(units).catch(notifyPageTranslationError)
  }

  function takePendingUnits() {
    const nodes = [...state.pendingNodes]
      .filter((node) => (
        !state.inFlightNodes.has(node) &&
        !isInsideInFlightElement(node) &&
        isTranslatableTextNode(node)
      ))
      .slice(0, maxNodes)
    state.pendingNodes.clear()

    if (translationMode === 'element-context') {
      return createElementContextUnits(nodes).slice(0, maxNodes)
    }

    const units = nodes.map((node): TextTranslationUnit => ({
      kind: 'text',
      node,
      sourceText: node.nodeValue || '',
    }))
    for (const unit of units) {
      state.inFlightNodes.add(unit.node)
    }

    return units
  }

  function createElementContextUnits(nodes: Text[]) {
    const units: PageTranslationUnit[] = []
    const seenElements = new Set<Element>()

    for (const node of nodes) {
      const element = getTranslationContextElement(node)
      if (
        !element ||
        seenElements.has(element) ||
        state.inFlightElements.has(element) ||
        !isTranslatableElementContext(element)
      ) {
        continue
      }

      const unit = createElementTranslationUnit(element)
      if (!unit) {
        continue
      }

      seenElements.add(element)
      state.inFlightElements.add(element)
      units.push(unit)
    }

    return units
  }

  function getTranslationContextElement(node: Text) {
    const parent = node.parentElement
    if (!parent) {
      return undefined
    }

    const contextElement = parent.closest(
      'p, li, h1, h2, h3, h4, h5, h6, blockquote, figcaption, caption, td, th, dt, dd, summary, label, button, a',
    )
    if (contextElement && document.body.contains(contextElement)) {
      return contextElement
    }

    return parent === document.body ? undefined : parent
  }

  function createElementTranslationUnit(element: Element): ElementTranslationUnit | undefined {
    const fragments: ProtectedFragment[] = []
    const sourceText = serializeElementForTranslation(element, fragments).trim()
    if (!isAllowedTextLength(sourceText)) {
      return undefined
    }

    return {
      kind: 'element',
      element,
      sourceText,
      originalHtml: element.innerHTML,
      fragments,
    }
  }

  function serializeElementForTranslation(element: Element, fragments: ProtectedFragment[]) {
    let text = ''

    for (const node of element.childNodes) {
      text += serializeNodeForTranslation(node, fragments)
    }

    return text
  }

  function serializeNodeForTranslation(node: Node, fragments: ProtectedFragment[]): string {
    if (node.nodeType === Node.TEXT_NODE) {
      return node.nodeValue || ''
    }

    if (!(node instanceof Element)) {
      return ''
    }

    if (isProtectedInlineElement(node)) {
      const token = createProtectedFragmentToken(fragments.length)
      fragments.push({ token, node: node.cloneNode(true) })
      return token
    }

    if (node.closest('[data-open-translate-ui], [data-open-translate-bilingual]')) {
      return ''
    }

    return serializeElementForTranslation(node, fragments)
  }

  function createProtectedFragmentToken(index: number) {
    return `__OPEN_TRANSLATE_KEEP_${index}__`
  }

  function requestTranslations(units: PageTranslationUnit[]) {
    const sourceTexts = units.map((unit) => unit.sourceText)
    if (translationProvider === 'chrome-built-in') {
      return requestBuiltInTranslations(units)
    }

    const requestId = createTranslationRequestId()
    state.translationRequests.set(requestId, { units })

    return new Promise<void>((resolve) => {
      chrome.runtime.sendMessage(
        { type: 'open-translate:translate-texts', requestId, texts: sourceTexts },
        (response) => {
          const pageTranslationResponse = response as PageTranslationResponse | undefined
          try {
            if (!isUsablePageTranslationResponse(pageTranslationResponse)) {
              return
            }

            applyPageTranslations(units, pageTranslationResponse)
          } finally {
            state.translationRequests.delete(requestId)
            releaseInFlightUnits(units)
            resolve()
          }
        },
      )
    })
  }

  async function requestBuiltInTranslations(units: PageTranslationUnit[]) {
    const sourceTexts = units.map((unit) => unit.sourceText)
    const entries = sourceTexts.map((sourceText, index) => ({ index, sourceText }))
      .filter((entry) => (
        isAllowedTextLength(entry.sourceText) &&
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
            unit?: PageTranslationUnit
            translatedText?: string
          }> = []

          for (const entry of batch) {
            translatedEntries.push({
              unit: units[entry.index],
              translatedText: await translateWithBuiltInAI(entry.sourceText),
            })
          }

          applyPageTranslationEntries(translatedEntries, displayMode)
          completed += batch.length
          await notifyPageTranslationProgress(completed, sourceTexts.length)
        },
      )
    } finally {
      releaseInFlightUnits(units)
    }
  }

  async function translateWithBuiltInAI(sourceText: string) {
    const sourceLanguage = await detectBuiltInSourceLanguage(sourceText)
    if (sourceLanguage === targetLanguageCode) {
      return sourceText
    }

    const translator = await getBuiltInTranslator(sourceLanguage, targetLanguageCode)
    return translator.translate(sourceText)
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
      return 'zh-Hans'
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
        unit: request.units[translation.index],
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
    units: PageTranslationUnit[],
    response: PageTranslationResponse,
  ) {
    applyPageTranslationEntries(
      units.map((unit, index) => ({
        unit,
        translatedText: response.translations?.[index],
      })),
      response.displayMode || 'translation',
    )
  }

  function applyPageTranslationEntries(
    entries: Array<{
      unit?: PageTranslationUnit
      translatedText?: string
    }>,
    displayMode: 'translation' | 'bilingual',
  ) {
    state.isApplyingTranslation = true
    try {
      for (const entry of entries) {
        if (
          !entry.unit ||
          !canApplyPageTranslation(entry.unit, entry.translatedText)
        ) {
          continue
        }

        applyPageTranslation(
          entry.unit,
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
    unit: PageTranslationUnit,
    translatedText?: string,
  ): translatedText is string {
    if (!translatedText) {
      return false
    }

    if (unit.kind === 'element') {
      return !!(
        unit.element.isConnected &&
        unit.element.innerHTML === unit.originalHtml &&
        isTranslatableElementContext(unit.element)
      )
    }

    return !!(
      unit.node.parentNode &&
      unit.node.nodeValue === unit.sourceText &&
      isTranslatableTextNode(unit.node)
    )
  }

  function releaseInFlightUnits(units: PageTranslationUnit[]) {
    for (const unit of units) {
      if (unit.kind === 'element') {
        state.inFlightElements.delete(unit.element)
        continue
      }

      state.inFlightNodes.delete(unit.node)
    }
  }

  function applyPageTranslation(
    unit: PageTranslationUnit,
    translatedText: string,
    displayMode: 'translation' | 'bilingual',
  ) {
    if (unit.kind === 'element') {
      applyElementTranslation(unit, translatedText, displayMode)
      return
    }

    applyTextTranslation(unit, translatedText, displayMode)
  }

  function applyTextTranslation(
    unit: TextTranslationUnit,
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
    originals.set(unit.node, { sourceText: unit.sourceText, translatedText })
    translatedTexts.add(translatedText)

    const nextSibling = unit.node.nextSibling
    if (
      nextSibling instanceof HTMLElement &&
      nextSibling.dataset.openTranslateBilingual === 'true'
    ) {
      nextSibling.remove()
    }

    if (displayMode === 'translation') {
      unit.node.nodeValue = translatedText
      return
    }

    unit.node.nodeValue = unit.sourceText
    unit.node.parentNode?.insertBefore(createPageBilingualText(translatedText), unit.node.nextSibling)
  }

  function applyElementTranslation(
    unit: ElementTranslationUnit,
    translatedText: string,
    displayMode: 'translation' | 'bilingual',
  ) {
    const pageWindow = window as typeof window & {
      __openTranslatePageElementOriginals?: Map<Element, PageElementTranslation>
      __openTranslatePageTranslations?: Set<string>
    }
    const originals =
      pageWindow.__openTranslatePageElementOriginals || new Map<Element, PageElementTranslation>()
    const translatedTexts = pageWindow.__openTranslatePageTranslations || new Set<string>()
    pageWindow.__openTranslatePageElementOriginals = originals
    pageWindow.__openTranslatePageTranslations = translatedTexts
    originals.set(unit.element, {
      sourceText: unit.sourceText,
      translatedText,
      originalHtml: unit.originalHtml,
    })
    translatedTexts.add(translatedText)
    unit.element.setAttribute('data-open-translate-element', 'true')

    const nextSibling = unit.element.nextSibling
    if (
      nextSibling instanceof HTMLElement &&
      nextSibling.dataset.openTranslateBilingual === 'true'
    ) {
      nextSibling.remove()
    }

    if (displayMode === 'translation') {
      replaceElementContentWithTranslation(unit.element, translatedText, unit.fragments)
      return
    }

    unit.element.parentNode?.insertBefore(
      createPageBilingualFragment(translatedText, unit.fragments),
      unit.element.nextSibling,
    )
  }

  function replaceElementContentWithTranslation(
    element: Element,
    translatedText: string,
    fragments: ProtectedFragment[],
  ) {
    element.replaceChildren(...createTranslatedNodes(translatedText, fragments))
  }

  function createPageBilingualFragment(
    translatedText: string,
    fragments: ProtectedFragment[],
  ) {
    const wrapper = document.createElement('font')
    wrapper.dataset.openTranslateBilingual = 'true'
    wrapper.style.cssText = `
      display: inline;
      margin-left: 0.35em;
    `
    wrapper.append(...createTranslatedNodes(translatedText, fragments))

    return wrapper
  }

  function createTranslatedNodes(translatedText: string, fragments: ProtectedFragment[]) {
    const nodes: Node[] = []
    const usedTokens = new Set<string>()
    const tokenPattern = /__OPEN_TRANSLATE_KEEP_(\d+)__/gi
    let lastIndex = 0

    for (const match of translatedText.matchAll(tokenPattern)) {
      const token = match[0]
      const index = match.index || 0
      const fragmentIndex = Number(match[1])
      if (index > lastIndex) {
        nodes.push(document.createTextNode(translatedText.slice(lastIndex, index)))
      }

      const fragment = Number.isInteger(fragmentIndex) ? fragments[fragmentIndex] : undefined
      if (fragment) {
        usedTokens.add(fragment.token)
      }
      nodes.push(fragment ? fragment.node.cloneNode(true) : document.createTextNode(token))
      lastIndex = index + token.length
    }

    if (lastIndex < translatedText.length) {
      nodes.push(document.createTextNode(translatedText.slice(lastIndex)))
    }

    for (const fragment of fragments) {
      if (!usedTokens.has(fragment.token)) {
        nodes.push(document.createTextNode(' '))
        nodes.push(fragment.node.cloneNode(true))
      }
    }

    return nodes.length ? nodes : [document.createTextNode(translatedText)]
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

    if (parent.closest('[data-open-translate-element="true"]')) {
      return false
    }

    if (isInNoTranslateElement(parent)) {
      return false
    }

    if (
      !isAllowedTextLength(text) ||
      /^[\d\s()[\]{}.,:;'"!?+\-*/\\|_=<>@#$%^&~`]+$/.test(text.trim())
    ) {
      return false
    }

    const rect = parent.getBoundingClientRect()
    const style = getComputedStyle(parent)
    return (
      rect.width > 0 &&
      rect.height > 0 &&
      (translationScope !== 'viewport' || isRectInViewport(rect)) &&
      style.visibility !== 'hidden' &&
      style.display !== 'none' &&
      Number(style.opacity) !== 0
    )
  }

  function isTranslatableElementContext(element: Element) {
    if (
      !element.isConnected ||
      ignoredTags.has(element.tagName) ||
      element.closest('[data-open-translate-ui], [data-open-translate-bilingual]') ||
      element.closest('[data-open-translate-element="true"]') ||
      isInNoTranslateElement(element)
    ) {
      return false
    }

    const rect = element.getBoundingClientRect()
    const style = getComputedStyle(element)
    return (
      rect.width > 0 &&
      rect.height > 0 &&
      (translationScope !== 'viewport' || isRectInViewport(rect)) &&
      style.visibility !== 'hidden' &&
      style.display !== 'none' &&
      Number(style.opacity) !== 0
    )
  }

  function isProtectedInlineElement(element: Element) {
    return (
      ignoredTags.has(element.tagName) ||
      element.matches('[data-open-translate-ui], [data-open-translate-bilingual]') ||
      matchesNoTranslateSelector(element)
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

  function isAllowedTextLength(text: string) {
    return text.trim().length >= minTranslationTextLength
  }

  function isInsideInFlightElement(node: Text) {
    const parent = node.parentElement
    return !!parent && [...state.inFlightElements].some((element) => element.contains(parent))
  }

  function isInNoTranslateElement(element: Element) {
    return !!(
      element.closest(
        "[data-open-translate-ui], [data-open-translate-selection-panel], [data-open-translate-bilingual], [data-open-translate-element='true']",
      ) ||
      noTranslateSelectors.some((selector) => matchesClosestSelector(element, selector))
    )
  }

  function matchesNoTranslateSelector(element: Element) {
    return noTranslateSelectors.some((selector) => matchesSelector(element, selector))
  }

  function matchesSelector(element: Element, selector: string) {
    const normalizedSelector = selector.trim()
    if (!normalizedSelector) {
      return false
    }

    try {
      return element.matches(normalizedSelector)
    } catch {
      return false
    }
  }

  function matchesClosestSelector(element: Element, selector: string) {
    const normalizedSelector = selector.trim()
    if (!normalizedSelector) {
      return false
    }

    try {
      return !!element.closest(normalizedSelector)
    } catch {
      return false
    }
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
    __openTranslatePageElementOriginals?: Map<Element, PageElementTranslation>
    __openTranslatePageSessionId?: number
    __openTranslatePageTranslations?: Set<string>
  },
) {
  const pageSessionId = (pageWindow.__openTranslatePageSessionId || 0) + 1

  pageWindow.__openTranslatePageSessionId = pageSessionId
  pageWindow.__openTranslatePageOriginals = new Map<Text, PageTextTranslation>()
  pageWindow.__openTranslatePageElementOriginals = new Map<Element, PageElementTranslation>()
  pageWindow.__openTranslatePageTranslations = new Set<string>()
  return pageSessionId
}
