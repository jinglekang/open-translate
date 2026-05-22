type PageTextTranslation = {
  sourceText: string
  translatedText: string
}

type PageRuntimeMessage = {
  type: 'open-translate:start-dynamic-page-translator'
  maxNodes: number
  pageSessionId: number
  pageTranslationScope: 'visible-page' | 'viewport'
}

const runtimeWindow = window as typeof window & {
  __openTranslatePageRuntimeInstalled?: boolean
}

if (!runtimeWindow.__openTranslatePageRuntimeInstalled) {
  chrome.runtime.onMessage.addListener((message) => {
    if (!isStartDynamicTranslatorMessage(message)) {
      return
    }

    installDynamicPageTranslator(
      message.maxNodes,
      message.pageSessionId,
      message.pageTranslationScope,
    )
  })
  runtimeWindow.__openTranslatePageRuntimeInstalled = true
}

function isStartDynamicTranslatorMessage(message: unknown): message is PageRuntimeMessage {
  return (
    !!message &&
    typeof message === 'object' &&
    (message as PageRuntimeMessage).type === 'open-translate:start-dynamic-page-translator' &&
    typeof (message as PageRuntimeMessage).maxNodes === 'number' &&
    typeof (message as PageRuntimeMessage).pageSessionId === 'number' &&
    (
      (message as PageRuntimeMessage).pageTranslationScope === 'visible-page' ||
      (message as PageRuntimeMessage).pageTranslationScope === 'viewport'
    )
  )
}

function installDynamicPageTranslator(
  maxNodes: number,
  pageSessionId: number,
  pageTranslationScope: 'visible-page' | 'viewport',
) {
  type DynamicState = {
    observer: MutationObserver
    removeScrollListener?: () => void
  }
  type DynamicResponse = {
    translations?: string[]
    displayMode?: 'translation' | 'bilingual'
    error?: string
  }

  const windowWithTranslator = window as typeof window & {
    __openTranslateDynamicTranslator?: DynamicState
    __openTranslatePageSessionId?: number
    __openTranslatePageOriginals?: Map<Text, PageTextTranslation>
    __openTranslatePageTranslations?: Set<string>
  }
  if (windowWithTranslator.__openTranslatePageSessionId !== pageSessionId) {
    return
  }

  windowWithTranslator.__openTranslateDynamicTranslator?.observer.disconnect()
  windowWithTranslator.__openTranslateDynamicTranslator?.removeScrollListener?.()

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
    isApplyingTranslation: false,
    debounceTimer: 0,
  }

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

  windowWithTranslator.__openTranslateDynamicTranslator = {
    observer,
    removeScrollListener:
      pageTranslationScope === 'viewport'
        ? () => window.removeEventListener('scroll', handleScroll)
        : undefined,
  }

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
    requestDynamicTranslations(nodes, sourceTexts)
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

  function requestDynamicTranslations(nodes: Text[], sourceTexts: string[]) {
    chrome.runtime.sendMessage(
      { type: 'open-translate:translate-texts', texts: sourceTexts },
      (response) => {
        const dynamicResponse = response as DynamicResponse | undefined
        try {
          if (!isUsableDynamicResponse(dynamicResponse)) {
            return
          }

          applyDynamicTranslations(nodes, sourceTexts, dynamicResponse)
        } finally {
          releaseInFlightNodes(nodes)
        }
      },
    )
  }

  function isUsableDynamicResponse(response?: DynamicResponse): response is DynamicResponse {
    return !(
      chrome.runtime.lastError ||
      response?.error ||
      !response?.translations ||
      windowWithTranslator.__openTranslatePageSessionId !== pageSessionId
    )
  }

  function applyDynamicTranslations(
    nodes: Text[],
    sourceTexts: string[],
    response: DynamicResponse,
  ) {
    state.isApplyingTranslation = true
    try {
      for (const [index, node] of nodes.entries()) {
        const translatedText = response.translations?.[index]
        if (!canApplyDynamicTranslation(node, sourceTexts[index], translatedText)) {
          continue
        }

        applyDynamicTranslation(
          node,
          sourceTexts[index],
          translatedText,
          response.displayMode || 'translation',
        )
      }
    } finally {
      window.setTimeout(() => {
        state.isApplyingTranslation = false
      }, 0)
    }
  }

  function canApplyDynamicTranslation(
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

  function applyDynamicTranslation(
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
    node.parentNode?.insertBefore(createDynamicBilingualText(translatedText), node.nextSibling)
  }

  function createDynamicBilingualText(translatedText: string) {
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
        "[contenteditable='true'], [data-open-translate-ui], [data-open-translate-selection-panel], [data-open-translate-bilingual]",
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
}
