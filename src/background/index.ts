import { t } from '../shared/i18n'
import { getActiveProfile, normalizeSettings, validateProfileForUse } from '../shared/settings'
import type {
  PageTranslationScope,
  TranslationDisplayMode,
  TranslationProfile,
  TranslationSettings,
} from '../shared/settings'
import { translateText } from './translation'

const PAGE_MENU_ID = "open-translate-page";
const SELECTION_MENU_ID = "open-translate-selection";

type PageTextNode = {
  path: number[];
  text: string;
};

type TextReplacement = {
  path: number[];
  sourceText: string;
  text: string;
};

type PageTextTranslation = {
  sourceText: string;
  translatedText: string;
};

type DynamicTranslateMessage = {
  type: "open-translate:translate-texts";
  texts: string[];
};

type TranslationProgress = {
  completed: number;
  total: number;
};

const MAX_TEXT_NODES = 180;
const PAGE_TRANSLATION_CONCURRENCY = 4;

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: PAGE_MENU_ID,
    title: t("contextMenuTranslateToLanguage", getDefaultTargetLanguage()),
    contexts: ["page"],
  });
  chrome.contextMenus.create({
    id: SELECTION_MENU_ID,
    title: t("contextMenuTranslateSelectionToLanguage", getDefaultTargetLanguage()),
    contexts: ["selection"],
  });
  void updateContextMenuTitles();
});

chrome.runtime.onStartup.addListener(() => {
  void updateContextMenuTitles();
});

chrome.tabs.onActivated.addListener(({ tabId }) => {
  void updatePageContextMenuTitleForTab(tabId);
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (tab.active && changeInfo.status) {
    void updatePageContextMenuTitleForTab(tabId);
  }
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (
    areaName === "sync" &&
    (changes.profiles || changes.activeProfileId || changes.targetLanguage)
  ) {
    void updateContextMenuTitles();
  }
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (
    (info.menuItemId !== PAGE_MENU_ID && info.menuItemId !== SELECTION_MENU_ID) ||
    !tab?.id
  ) {
    return;
  }

  try {
    if (info.menuItemId === PAGE_MENU_ID && await restoreTranslatedPage(tab.id)) {
      await updatePageContextMenuTitleForTab(tab.id);
      await showInlineNotice(tab.id, t("pageOriginalShown"), "success");
      return;
    }

    const settings = await getCurrentSettings();
    const profile = validateProfileForUse(getActiveProfile(settings));

    const selectedText = (info.selectionText || "").trim();
    if (selectedText) {
      await translateSelection(tab.id, selectedText, profile, settings.displayMode);
      return;
    }

    await translatePage(tab.id, profile, settings.displayMode, settings.pageTranslationScope);
  } catch (error) {
    const message = error instanceof Error ? error.message : t("translationFailed");
    await showInlineNotice(tab.id, message, "error");
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!isDynamicTranslateMessage(message)) {
    return false;
  }

  const tabId = sender.tab?.id;
  void translateDynamicTexts(message.texts, tabId)
    .then((response) => sendResponse(response))
    .catch((error) => {
      sendResponse({
        error: error instanceof Error ? error.message : t("translationFailed"),
      });
    });

  return true;
});

function isDynamicTranslateMessage(message: unknown): message is DynamicTranslateMessage {
  return (
    !!message &&
    typeof message === "object" &&
    (message as DynamicTranslateMessage).type === "open-translate:translate-texts" &&
    Array.isArray((message as DynamicTranslateMessage).texts)
  );
}

async function translateSelection(
  tabId: number,
  selectedText: string,
  profile: TranslationProfile,
  displayMode: TranslationDisplayMode,
) {
  await showInlineNotice(tabId, t("translatingSelection"), "loading");
  const translatedText = await translateText(selectedText, profile);

  const [{ result: didShow }] = await chrome.scripting.executeScript({
    target: { tabId },
    func: renderSelectionTranslationPanel,
    args: [selectedText, translatedText, displayMode, t("close")],
  });

  await showInlineNotice(
    tabId,
    didShow ? t("selectionTranslated") : t("selectionNotFound"),
    didShow ? "success" : "error",
  );
}

async function translatePage(
  tabId: number,
  profile: TranslationProfile,
  displayMode: TranslationDisplayMode,
  pageTranslationScope: PageTranslationScope,
) {
  await showInlineNotice(tabId, t("collectingPageText"), "loading");

  const [{ result: pageSessionId = 0 }] = await chrome.scripting.executeScript<[], number>({
    target: { tabId },
    func: beginPageTranslationSession,
  });

  const [{ result: textNodes = [] }] = await chrome.scripting.executeScript<
    [number, PageTranslationScope],
    PageTextNode[]
  >({
    target: { tabId },
    func: collectPageTextNodes,
    args: [MAX_TEXT_NODES, pageTranslationScope],
  });

  if (!textNodes.length) {
    throw new Error(t("pageTextNotFound"));
  }

  const progress = createPageTranslationProgress(tabId);
  await translateItems(
    textNodes,
    (item) => item.text,
    profile,
    progress.update,
    async (item, translatedText) => {
      await chrome.scripting.executeScript({
        target: { tabId },
        func: replacePageTextNodes,
        args: [[{
          path: item.path,
          sourceText: item.text,
          text: translatedText || item.text,
        }], displayMode, pageSessionId],
      });
    },
  );

  await showInlineNotice(tabId, t("pageTranslated"), "success");
  await chrome.contextMenus.update(PAGE_MENU_ID, {
    title: t("contextMenuShowOriginal"),
  });
  await chrome.scripting.executeScript({
    target: { tabId },
    func: installDynamicPageTranslator,
    args: [MAX_TEXT_NODES, pageSessionId, pageTranslationScope],
  });
}

async function restoreTranslatedPage(tabId: number) {
  const [{ result: didRestore = false }] = await chrome.scripting.executeScript<[], boolean>({
    target: { tabId },
    func: restorePageOriginalText,
  });

  return didRestore;
}

async function getCurrentSettings(): Promise<TranslationSettings> {
  const stored = await chrome.storage.sync.get(null);
  return normalizeSettings(stored);
}

async function updateContextMenuTitles() {
  const settings = await getCurrentSettings();
  const targetLanguage = getActiveProfile(settings).targetLanguage || getDefaultTargetLanguage();

  await Promise.allSettled([
    chrome.contextMenus.update(PAGE_MENU_ID, {
      title: t("contextMenuTranslateToLanguage", targetLanguage),
    }),
    chrome.contextMenus.update(SELECTION_MENU_ID, {
      title: t("contextMenuTranslateSelectionToLanguage", targetLanguage),
    }),
  ]);
}

async function updatePageContextMenuTitleForTab(tabId: number) {
  const settings = await getCurrentSettings();
  const targetLanguage = getActiveProfile(settings).targetLanguage || getDefaultTargetLanguage();
  let isTranslated = false;

  try {
    const [{ result = false }] = await chrome.scripting.executeScript<[], boolean>({
      target: { tabId },
      func: isPageTranslationActive,
    });
    isTranslated = result;
  } catch {
    // Some browser pages do not allow extension scripts.
  }

  await chrome.contextMenus.update(PAGE_MENU_ID, {
    title: isTranslated
      ? t("contextMenuShowOriginal")
      : t("contextMenuTranslateToLanguage", targetLanguage),
  });
}

function getDefaultTargetLanguage() {
  return t("targetLanguagePlaceholder");
}

async function translateDynamicTexts(texts: string[], tabId?: number) {
  const settings = await getCurrentSettings();
  const profile = validateProfileForUse(getActiveProfile(settings));
  const normalizedTexts = texts.map((text) => text.trim()).filter(Boolean);

  if (!normalizedTexts.length) {
    return {
      translations: [],
      displayMode: settings.displayMode,
    };
  }

  const translations = await translateItems(
    normalizedTexts,
    (text) => text,
    profile,
    tabId ? createPageTranslationProgress(tabId).update : undefined,
  );

  return {
    translations,
    displayMode: settings.displayMode,
  };
}

async function runConcurrent<T>(
  items: T[],
  concurrency: number,
  worker: (item: T) => Promise<void>,
) {
  let nextIndex = 0;

  async function runWorker() {
    while (nextIndex < items.length) {
      const item = items[nextIndex];
      nextIndex += 1;
      await worker(item);
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, () => runWorker()),
  );
}

async function translateItems<T>(
  items: T[],
  getSourceText: (item: T) => string,
  profile: TranslationProfile,
  onProgress?: (progress: TranslationProgress) => Promise<void>,
  onTranslated?: (item: T, translatedText: string) => Promise<void>,
) {
  const translations: string[] = new Array(items.length);
  let completed = 0;

  if (onProgress) {
    await onProgress({ completed, total: items.length });
  }

  await runConcurrent(
    items.map((item, index) => ({ index, item })),
    PAGE_TRANSLATION_CONCURRENCY,
    async ({ index, item }) => {
      const translatedText = await translateText(getSourceText(item), profile);
      translations[index] = translatedText;
      await onTranslated?.(item, translatedText);

      completed += 1;
      await onProgress?.({ completed, total: items.length });
    },
  );

  return translations;
}

function createPageTranslationProgress(tabId: number) {
  let noticeQueue = Promise.resolve();

  return {
    update(progress: TranslationProgress) {
      noticeQueue = noticeQueue.then(() => showOptionalInlineNotice(
        tabId,
        t("translatingPageBatch", [String(progress.completed), String(progress.total)]),
        progress.completed < progress.total ? "loading" : "success",
      ));

      return noticeQueue;
    },
  };
}

async function showInlineNotice(
  tabId: number,
  message: string,
  status: "loading" | "success" | "error",
) {
  await chrome.scripting.executeScript({
    target: { tabId },
    func: renderInlineNotice,
    args: [message, status],
  });
}

async function showOptionalInlineNotice(
  tabId: number,
  message: string,
  status: "loading" | "success" | "error",
) {
  try {
    await showInlineNotice(tabId, message, status);
  } catch {
    // Dynamic page translation should continue even if a notice cannot render.
  }
}

function collectPageTextNodes(
  maxNodes: number,
  pageTranslationScope: "visible-page" | "viewport",
) {
  const ignoredTags = new Set([
    "SCRIPT",
    "STYLE",
    "NOSCRIPT",
    "IFRAME",
    "SVG",
    "CANVAS",
    "TEXTAREA",
    "INPUT",
    "SELECT",
    "OPTION",
  ]);
  const nodes: PageTextNode[] = [];
  const walker = document.createTreeWalker(
    document.body,
    NodeFilter.SHOW_TEXT,
    {
      acceptNode(node) {
        const parent = node.parentElement;
        const text = node.nodeValue || "";

        if (!parent || ignoredTags.has(parent.tagName)) {
          return NodeFilter.FILTER_REJECT;
        }

        if (
          parent.closest(
            "[contenteditable='true'], [data-open-translate-ui], [data-open-translate-bilingual]",
          )
        ) {
          return NodeFilter.FILTER_REJECT;
        }

        if (!text.trim() || isLikelyNonLanguage(text)) {
          return NodeFilter.FILTER_REJECT;
        }

        const rect = parent.getBoundingClientRect();
        const style = getComputedStyle(parent);
        if (
          rect.width === 0 ||
          rect.height === 0 ||
          (pageTranslationScope === "viewport" && !isRectInViewport(rect)) ||
          style.visibility === "hidden" ||
          style.display === "none" ||
          Number(style.opacity) === 0
        ) {
          return NodeFilter.FILTER_REJECT;
        }

        return NodeFilter.FILTER_ACCEPT;
      },
    },
  );

  while (nodes.length < maxNodes) {
    const node = walker.nextNode();
    if (!node) {
      break;
    }

    nodes.push({
      path: getNodePath(node),
      text: node.nodeValue || "",
    });
  }

  return nodes;

  function isLikelyNonLanguage(text: string) {
    const trimmed = text.trim();
    return /^[\d\s()[\]{}.,:;'"!?+\-*/\\|_=<>@#$%^&~`]+$/.test(trimmed);
  }

  function isRectInViewport(rect: DOMRect) {
    return (
      rect.bottom > 0 &&
      rect.right > 0 &&
      rect.top < window.innerHeight &&
      rect.left < window.innerWidth
    );
  }

  function getNodePath(node: Node) {
    const path: number[] = [];
    let current = node;

    while (current && current !== document.body) {
      const parent = current.parentNode;
      if (!parent) {
        break;
      }

      path.unshift(Array.prototype.indexOf.call(parent.childNodes, current));
      current = parent;
    }

    return path;
  }
}

function replacePageTextNodes(
  replacements: TextReplacement[],
  displayMode: "translation" | "bilingual",
  pageSessionId: number,
) {
  const pageWindow = window as typeof window & {
    __openTranslatePageOriginals?: Map<Text, PageTextTranslation>;
    __openTranslatePageSessionId?: number;
    __openTranslatePageTranslations?: Set<string>;
  };
  if (pageWindow.__openTranslatePageSessionId !== pageSessionId) {
    return;
  }

  const originals =
    pageWindow.__openTranslatePageOriginals || new Map<Text, PageTextTranslation>();
  const translatedTexts = pageWindow.__openTranslatePageTranslations || new Set<string>();
  pageWindow.__openTranslatePageOriginals = originals;
  pageWindow.__openTranslatePageTranslations = translatedTexts;
  const orderedReplacements =
    displayMode === "bilingual"
      ? [...replacements].sort((left, right) => compareNodePathDesc(left.path, right.path))
      : replacements;

  for (const replacement of orderedReplacements) {
    const node = getReplacementTextNode(replacement);
    if (node?.nodeType === Node.TEXT_NODE) {
      originals.set(node as Text, {
        sourceText: replacement.sourceText,
        translatedText: replacement.text,
      });
      translatedTexts.add(replacement.text);

      const nextSibling = node.nextSibling;
      if (
        nextSibling instanceof HTMLElement &&
        nextSibling.dataset.openTranslateBilingual === "true"
      ) {
        nextSibling.remove();
      }

      if (displayMode === "translation") {
        node.nodeValue = replacement.text;
      } else {
        node.nodeValue = replacement.sourceText;
        node.parentNode?.insertBefore(createBilingualText(replacement.text), node.nextSibling);
      }
    }
  }

  function createBilingualText(translatedText: string) {
    const wrapper = document.createElement("font");
    wrapper.dataset.openTranslateBilingual = "true";
    wrapper.textContent = translatedText;
    wrapper.style.cssText = `
      display: inline;
      margin-left: 0.35em;
    `;

    return wrapper;
  }

  function compareNodePathDesc(left: number[], right: number[]) {
    const length = Math.max(left.length, right.length);
    for (let index = 0; index < length; index += 1) {
      const leftValue = left[index] ?? -1;
      const rightValue = right[index] ?? -1;
      if (leftValue !== rightValue) {
        return rightValue - leftValue;
      }
    }

    return 0;
  }

  function getNodeByPath(path: number[]) {
    let current: Node | null = document.body;
    for (const index of path) {
      current = current?.childNodes?.[index];
      if (!current) {
        return null;
      }
    }

    return current;
  }

  function getReplacementTextNode(replacement: TextReplacement) {
    const node = getNodeByPath(replacement.path);
    if (node?.nodeType === Node.TEXT_NODE && node.nodeValue === replacement.sourceText) {
      return node;
    }

    return findTextNodeByContent(replacement.sourceText);
  }

  function findTextNodeByContent(sourceText: string) {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        const parent = node.parentElement;
        if (
          node.nodeValue === sourceText &&
          parent &&
          !parent.closest("[data-open-translate-ui], [data-open-translate-bilingual]")
        ) {
          return NodeFilter.FILTER_ACCEPT;
        }

        return NodeFilter.FILTER_REJECT;
      },
    });

    return walker.nextNode();
  }
}

function installDynamicPageTranslator(
  maxNodes: number,
  pageSessionId: number,
  pageTranslationScope: "visible-page" | "viewport",
) {
  type DynamicState = {
    observer: MutationObserver;
    removeScrollListener?: () => void;
  };
  type DynamicResponse = {
    translations?: string[];
    displayMode?: "translation" | "bilingual";
    error?: string;
  };

  const windowWithTranslator = window as typeof window & {
    __openTranslateDynamicTranslator?: DynamicState;
    __openTranslatePageSessionId?: number;
    __openTranslatePageOriginals?: Map<Text, PageTextTranslation>;
    __openTranslatePageTranslations?: Set<string>;
  };
  if (windowWithTranslator.__openTranslatePageSessionId !== pageSessionId) {
    return;
  }

  windowWithTranslator.__openTranslateDynamicTranslator?.observer.disconnect();
  windowWithTranslator.__openTranslateDynamicTranslator?.removeScrollListener?.();

  const ignoredTags = new Set([
    "SCRIPT",
    "STYLE",
    "NOSCRIPT",
    "IFRAME",
    "SVG",
    "CANVAS",
    "TEXTAREA",
    "INPUT",
    "SELECT",
    "OPTION",
  ]);
  const pendingNodes = new Set<Text>();
  const inFlightNodes = new Set<Text>();
  let isApplyingTranslation = false;
  let debounceTimer = 0;

  const observer = new MutationObserver((mutations) => {
    if (isApplyingTranslation) {
      return;
    }

    for (const mutation of mutations) {
      if (mutation.type === "characterData" && mutation.target.nodeType === Node.TEXT_NODE) {
        enqueueTextNode(mutation.target as Text);
      }

      for (const node of mutation.addedNodes) {
        collectTextNodes(node);
      }
    }

    scheduleFlush();
  });

  observer.observe(document.body, {
    childList: true,
    characterData: true,
    subtree: true,
  });
  const handleScroll = () => {
    scheduleViewportFlush();
  };

  if (pageTranslationScope === "viewport") {
    window.addEventListener("scroll", handleScroll, { passive: true });
  }

  windowWithTranslator.__openTranslateDynamicTranslator = {
    observer,
    removeScrollListener:
      pageTranslationScope === "viewport"
        ? () => window.removeEventListener("scroll", handleScroll)
        : undefined,
  };

  function collectTextNodes(node: Node) {
    if (pendingNodes.size >= maxNodes) {
      return;
    }

    if (node.nodeType === Node.TEXT_NODE) {
      enqueueTextNode(node as Text);
      return;
    }

    if (!(node instanceof Element) || ignoredTags.has(node.tagName)) {
      return;
    }

    if (node.closest("[data-open-translate-ui], [data-open-translate-bilingual]")) {
      return;
    }

    const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT, {
      acceptNode(textNode) {
        return isTranslatableTextNode(textNode as Text)
          ? NodeFilter.FILTER_ACCEPT
          : NodeFilter.FILTER_REJECT;
      },
    });

    while (pendingNodes.size < maxNodes) {
      const textNode = walker.nextNode();
      if (!textNode) {
        break;
      }

      enqueueTextNode(textNode as Text);
    }
  }

  function enqueueTextNode(node: Text) {
    if (!inFlightNodes.has(node) && isTranslatableTextNode(node)) {
      pendingNodes.add(node);
    }
  }

  function scheduleFlush() {
    window.clearTimeout(debounceTimer);
    debounceTimer = window.setTimeout(flushPendingNodes, 650);
  }

  function scheduleViewportFlush() {
    window.clearTimeout(debounceTimer);
    debounceTimer = window.setTimeout(() => {
      collectTextNodes(document.body);
      flushPendingNodes();
    }, 220);
  }

  function flushPendingNodes() {
    const nodes = [...pendingNodes]
      .filter((node) => !inFlightNodes.has(node) && isTranslatableTextNode(node))
      .slice(0, maxNodes);
    pendingNodes.clear();

    if (!nodes.length) {
      return;
    }

    for (const node of nodes) {
      inFlightNodes.add(node);
    }

    const sourceTexts = nodes.map((node) => node.nodeValue || "");
    chrome.runtime.sendMessage(
      { type: "open-translate:translate-texts", texts: sourceTexts },
      (response) => {
        const dynamicResponse = response as DynamicResponse | undefined;
        try {
          if (
            chrome.runtime.lastError ||
            dynamicResponse?.error ||
            !dynamicResponse?.translations ||
            windowWithTranslator.__openTranslatePageSessionId !== pageSessionId
          ) {
            return;
          }

          isApplyingTranslation = true;
          try {
            for (const [index, node] of nodes.entries()) {
              const translatedText = dynamicResponse.translations[index];
              if (
                !translatedText ||
                !node.parentNode ||
                node.nodeValue !== sourceTexts[index] ||
                !isTranslatableTextNode(node)
              ) {
                continue;
              }

              applyDynamicTranslation(
                node,
                sourceTexts[index],
                translatedText,
                dynamicResponse.displayMode || "translation",
              );
            }
          } finally {
            window.setTimeout(() => {
              isApplyingTranslation = false;
            }, 0);
          }
        } finally {
          for (const node of nodes) {
            inFlightNodes.delete(node);
          }
        }
      },
    );
  }

  function applyDynamicTranslation(
    node: Text,
    sourceText: string,
    translatedText: string,
    displayMode: "translation" | "bilingual",
  ) {
    const pageWindow = window as typeof window & {
      __openTranslatePageOriginals?: Map<Text, PageTextTranslation>;
      __openTranslatePageTranslations?: Set<string>;
    };
    const originals =
      pageWindow.__openTranslatePageOriginals || new Map<Text, PageTextTranslation>();
    const translatedTexts = pageWindow.__openTranslatePageTranslations || new Set<string>();
    pageWindow.__openTranslatePageOriginals = originals;
    pageWindow.__openTranslatePageTranslations = translatedTexts;
    originals.set(node, { sourceText, translatedText });
    translatedTexts.add(translatedText);

    const nextSibling = node.nextSibling;
    if (
      nextSibling instanceof HTMLElement &&
      nextSibling.dataset.openTranslateBilingual === "true"
    ) {
      nextSibling.remove();
    }

    if (displayMode === "translation") {
      node.nodeValue = translatedText;
      return;
    }

    node.nodeValue = sourceText;
    node.parentNode?.insertBefore(createDynamicBilingualText(translatedText), node.nextSibling);
  }

  function createDynamicBilingualText(translatedText: string) {
    const wrapper = document.createElement("font");
    wrapper.dataset.openTranslateBilingual = "true";
    wrapper.textContent = translatedText;
    wrapper.style.cssText = `
      display: inline;
      margin-left: 0.35em;
    `;

    return wrapper;
  }

  function isTranslatableTextNode(node: Text) {
    const parent = node.parentElement;
    const text = node.nodeValue || "";
    const existingTranslation = windowWithTranslator.__openTranslatePageOriginals?.get(node);

    if (!parent || ignoredTags.has(parent.tagName)) {
      return false;
    }

    if (
      existingTranslation &&
      (
        text === existingTranslation.translatedText ||
        (
          text === existingTranslation.sourceText &&
          node.nextSibling instanceof HTMLElement &&
          node.nextSibling.dataset.openTranslateBilingual === "true"
        )
      )
    ) {
      return false;
    }

    if (windowWithTranslator.__openTranslatePageTranslations?.has(text)) {
      return false;
    }

    if (
      parent.closest(
        "[contenteditable='true'], [data-open-translate-ui], [data-open-translate-selection-panel], [data-open-translate-bilingual]",
      )
    ) {
      return false;
    }

    if (!text.trim() || /^[\d\s()[\]{}.,:;'"!?+\-*/\\|_=<>@#$%^&~`]+$/.test(text.trim())) {
      return false;
    }

    const rect = parent.getBoundingClientRect();
    const style = getComputedStyle(parent);
    return (
      rect.width > 0 &&
      rect.height > 0 &&
      (pageTranslationScope !== "viewport" || isRectInViewport(rect)) &&
      style.visibility !== "hidden" &&
      style.display !== "none" &&
      Number(style.opacity) !== 0
    );
  }

  function isRectInViewport(rect: DOMRect) {
    return (
      rect.bottom > 0 &&
      rect.right > 0 &&
      rect.top < window.innerHeight &&
      rect.left < window.innerWidth
    );
  }
}

function beginPageTranslationSession() {
  const pageWindow = window as typeof window & {
    __openTranslatePageOriginals?: Map<Text, PageTextTranslation>;
    __openTranslatePageSessionId?: number;
    __openTranslatePageTranslations?: Set<string>;
  };
  const pageSessionId = (pageWindow.__openTranslatePageSessionId || 0) + 1;

  pageWindow.__openTranslatePageSessionId = pageSessionId;
  pageWindow.__openTranslatePageOriginals = new Map<Text, PageTextTranslation>();
  pageWindow.__openTranslatePageTranslations = new Set<string>();
  return pageSessionId;
}

function isPageTranslationActive() {
  const pageWindow = window as typeof window & {
    __openTranslatePageOriginals?: Map<Text, PageTextTranslation>;
  };

  return !!pageWindow.__openTranslatePageOriginals?.size;
}

function restorePageOriginalText() {
  const pageWindow = window as typeof window & {
    __openTranslatePageOriginals?: Map<Text, PageTextTranslation>;
    __openTranslateDynamicTranslator?: {
      observer: MutationObserver;
      removeScrollListener?: () => void;
    };
    __openTranslatePageSessionId?: number;
    __openTranslatePageTranslations?: Set<string>;
  };
  const originals = pageWindow.__openTranslatePageOriginals;
  const bilingualTexts = document.querySelectorAll("[data-open-translate-bilingual='true']");
  const didRestore = !!originals?.size || bilingualTexts.length > 0;

  pageWindow.__openTranslateDynamicTranslator?.observer.disconnect();
  pageWindow.__openTranslateDynamicTranslator?.removeScrollListener?.();
  delete pageWindow.__openTranslateDynamicTranslator;

  for (const translatedText of bilingualTexts) {
    translatedText.remove();
  }

  for (const [node, translation] of originals || []) {
    if (node.isConnected) {
      node.nodeValue = translation.sourceText;
    }
  }

  originals?.clear();
  pageWindow.__openTranslatePageTranslations?.clear();
  delete pageWindow.__openTranslatePageOriginals;
  delete pageWindow.__openTranslatePageSessionId;
  delete pageWindow.__openTranslatePageTranslations;
  return didRestore;
}

function renderSelectionTranslationPanel(
  sourceText: string,
  translatedText: string,
  displayMode: "translation" | "bilingual",
  closeLabel: string,
) {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0) {
    return false;
  }

  const range = selection.getRangeAt(0);
  const rect = range.getBoundingClientRect();
  if (!rect.width && !rect.height) {
    return false;
  }

  document.querySelector("[data-open-translate-selection-panel]")?.remove();

  const panel = document.createElement("section");
  panel.dataset.openTranslateSelectionPanel = "true";
  panel.setAttribute("role", "dialog");
  panel.setAttribute("aria-live", "polite");

  const content = document.createElement("div");
  if (displayMode === "bilingual") {
    const source = document.createElement("p");
    source.textContent = sourceText;
    source.style.cssText = `
      margin: 0 0 8px;
      color: #64748b;
      border-bottom: 1px solid #e7eaf0;
      padding-bottom: 8px;
    `;

    const translation = document.createElement("p");
    translation.textContent = translatedText;
    translation.style.cssText = `
      margin: 0;
      color: #172033;
    `;

    content.append(source, translation);
  } else {
    content.textContent = translatedText;
  }

  const closeButton = document.createElement("button");
  closeButton.type = "button";
  closeButton.textContent = "×";
  closeButton.title = closeLabel;
  closeButton.addEventListener("click", () => panel.remove());

  panel.append(content, closeButton);
  panel.style.cssText = `
    position: fixed;
    z-index: 2147483647;
    width: min(360px, calc(100vw - 24px));
    max-height: min(280px, calc(100vh - 24px));
    overflow: auto;
    padding: 12px 42px 12px 14px;
    color: #172033;
    background: #ffffff;
    border: 1px solid #d8dde8;
    border-radius: 8px;
    box-shadow: 0 14px 36px rgba(17, 24, 39, 0.2);
    font: 14px/1.55 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    white-space: pre-wrap;
    word-break: break-word;
  `;
  closeButton.style.cssText = `
    position: absolute;
    top: 6px;
    right: 6px;
    width: 28px;
    height: 28px;
    border: 0;
    border-radius: 6px;
    color: #64748b;
    background: transparent;
    font: 18px/1 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    cursor: pointer;
  `;

  document.documentElement.append(panel);

  const panelRect = panel.getBoundingClientRect();
  const spacing = 8;
  const preferredTop = rect.bottom + spacing;
  const top =
    preferredTop + panelRect.height <= window.innerHeight - spacing
      ? preferredTop
      : Math.max(spacing, rect.top - panelRect.height - spacing);
  const left = Math.min(
    Math.max(spacing, rect.left),
    window.innerWidth - panelRect.width - spacing,
  );

  panel.style.top = `${top}px`;
  panel.style.left = `${left}px`;
  return true;
}

function renderInlineNotice(message: string, status: "loading" | "success" | "error") {
  document.querySelector("[data-open-translate-ui]")?.remove();
  const isError = status === "error";

  const notice = document.createElement("div");
  notice.dataset.openTranslateUi = "true";
  notice.dataset.status = status;
  notice.textContent = message;
  notice.style.cssText = `
    position: fixed;
    left: 50%;
    bottom: 24px;
    z-index: 2147483647;
    max-width: min(520px, calc(100vw - 32px));
    transform: translateX(-50%);
    padding: 10px 14px;
    color: ${isError ? "#991b1b" : "#172033"};
    background: ${isError ? "#fee2e2" : "#ffffff"};
    border: 1px solid ${isError ? "#fecaca" : "#d8dde8"};
    border-radius: 8px;
    box-shadow: 0 12px 32px rgba(17, 24, 39, 0.18);
    font: 14px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  `;

  document.documentElement.append(notice);
  if (status !== "loading") {
    window.setTimeout(() => notice.remove(), isError ? 6000 : 2200);
  }
}
