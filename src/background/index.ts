import { setAppLanguage, t } from '../shared/i18n'
import { defaultTargetLanguage, normalizeBuiltInTargetLanguageCode } from '../shared/languages'
import { getActiveProfile, normalizeSettings, validateProfileForUse } from '../shared/settings'
import type {
  TranslationDisplayMode,
  TranslationMode,
  TranslationProfile,
  TranslationProvider,
  TranslationScope,
  TranslationSettings,
} from '../shared/settings'
import { shouldSkipTranslation } from '../shared/whitelist'
import { getCachedTranslations, translateText, translateTextBatch } from './translation'

const PAGE_MENU_ID = "open-translate-page";
const SELECTION_MENU_ID = "open-translate-selection";

type PageTextTranslation = {
  sourceText: string;
  translatedText: string;
};

type PageTranslateMessage = {
  type: "open-translate:translate-texts";
  requestId: string;
  translationSessionId: string;
  progressCompleted: number;
  progressTotal: number;
  texts: string[];
};

type InitialPageTranslationCompleteMessage = {
  type: "open-translate:initial-page-translation-complete";
  translationSessionId: string;
};

type PageTranslationProgressMessage = {
  type: "open-translate:page-translation-progress";
  translationSessionId: string;
  completed: number;
  total: number;
};

type PageTranslationErrorMessage = {
  type: "open-translate:page-translation-error";
  translationSessionId: string;
  message: string;
};

type TranslationProgress = {
  completed: number;
  total: number;
};

type PageTranslationProgressSession = {
  id: string;
  noticeQueue: Promise<void>;
};

const MAX_TEXT_NODES_PER_ROUND = 180;
const pageTranslationProgressSessions = new Map<number, PageTranslationProgressSession>();

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
    (changes.profiles || changes.activeProfileId || changes.targetLanguage || changes.appLanguage)
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
      await translateSelection(
        tab.id,
        selectedText,
        profile,
        settings.targetLanguage,
        settings.userWhitelist,
        settings.minTranslationTextLength,
        settings.displayMode,
        settings.maxTranslationCacheEntries,
      );
      return;
    }

    await translatePage(
      tab.id,
      settings.translationScope,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : t("translationFailed");
    await showInlineNotice(tab.id, message, "error");
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (isPageTranslationErrorMessage(message)) {
    if (
      sender.tab?.id &&
      isCurrentPageTranslationSession(sender.tab.id, message.translationSessionId)
    ) {
      void showInlineNotice(sender.tab.id, message.message || t("translationFailed"), "error");
    }
    return false;
  }

  if (isPageTranslationProgressMessage(message)) {
    if (sender.tab?.id) {
      void showPageTranslationProgress(
        sender.tab.id,
        message.translationSessionId,
        message,
      );
    }
    return false;
  }

  if (isInitialPageTranslationCompleteMessage(message)) {
    if (
      sender.tab?.id &&
      isCurrentPageTranslationSession(sender.tab.id, message.translationSessionId)
    ) {
      void showPageTranslationComplete(sender.tab.id);
    }
    return false;
  }

  if (!isPageTranslateMessage(message)) {
    return false;
  }

  const tabId = sender.tab?.id;
  void translatePageTexts(
    message.texts,
    tabId,
    message.requestId,
    message.translationSessionId,
    message.progressCompleted,
    message.progressTotal,
  )
    .then((response) => sendResponse(response))
    .catch((error) => {
      sendResponse({
        error: error instanceof Error ? error.message : t("translationFailed"),
      });
    });

  return true;
});

function isInitialPageTranslationCompleteMessage(
  message: unknown,
): message is InitialPageTranslationCompleteMessage {
  return (
    !!message &&
    typeof message === "object" &&
    (message as InitialPageTranslationCompleteMessage).type ===
    "open-translate:initial-page-translation-complete" &&
    typeof (message as InitialPageTranslationCompleteMessage).translationSessionId === "string"
  );
}

function isPageTranslationErrorMessage(
  message: unknown,
): message is PageTranslationErrorMessage {
  return (
    !!message &&
    typeof message === "object" &&
    (message as PageTranslationErrorMessage).type ===
    "open-translate:page-translation-error" &&
    typeof (message as PageTranslationErrorMessage).translationSessionId === "string" &&
    typeof (message as PageTranslationErrorMessage).message === "string"
  );
}

function isPageTranslationProgressMessage(
  message: unknown,
): message is PageTranslationProgressMessage {
  return (
    !!message &&
    typeof message === "object" &&
    (message as PageTranslationProgressMessage).type ===
    "open-translate:page-translation-progress" &&
    typeof (message as PageTranslationProgressMessage).translationSessionId === "string" &&
    typeof (message as PageTranslationProgressMessage).completed === "number" &&
    typeof (message as PageTranslationProgressMessage).total === "number"
  );
}

function isPageTranslateMessage(message: unknown): message is PageTranslateMessage {
  return (
    !!message &&
    typeof message === "object" &&
    (message as PageTranslateMessage).type === "open-translate:translate-texts" &&
    typeof (message as PageTranslateMessage).requestId === "string" &&
    typeof (message as PageTranslateMessage).translationSessionId === "string" &&
    typeof (message as PageTranslateMessage).progressCompleted === "number" &&
    typeof (message as PageTranslateMessage).progressTotal === "number" &&
    Array.isArray((message as PageTranslateMessage).texts)
  );
}

async function translateSelection(
  tabId: number,
  selectedText: string,
  profile: TranslationProfile,
  targetLanguage: string,
  userWhitelist: string[],
  minTranslationTextLength: number,
  displayMode: TranslationDisplayMode,
  maxCacheEntries: number,
) {
  await showInlineNotice(tabId, t("translatingSelection"), "loading");
  const translatedText =
    shouldSkipTranslation(selectedText, userWhitelist, minTranslationTextLength)
      ? selectedText
      : profile.provider === "built-in-translator"
        ? await translateSelectionWithBuiltInTranslator(tabId, selectedText, targetLanguage)
        : await translateText(
          selectedText,
          profile,
          targetLanguage,
          userWhitelist,
          minTranslationTextLength,
          'text-node',
          maxCacheEntries,
        );

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

async function translateSelectionWithBuiltInTranslator(
  tabId: number,
  selectedText: string,
  targetLanguage: string,
) {
  const targetLanguageCode = normalizeBuiltInTargetLanguageCode(targetLanguage);
  await chrome.scripting.executeScript({
    target: { tabId },
    files: ["page-runtime.js"],
  });

  const response = await chrome.tabs.sendMessage<{
    translatedText?: string;
    error?: string;
  }>(tabId, {
    type: "open-translate:translate-text-with-built-in-ai",
    sourceText: selectedText,
    targetLanguageCode,
    builtInAiUnavailableMessage: t("builtInAiUnavailable"),
    builtInAiUnsupportedLanguagePairMessage: t("builtInAiUnsupportedLanguagePair"),
  });

  if (response?.error) {
    throw new Error(response.error);
  }

  if (!response?.translatedText) {
    throw new Error(t("emptyTranslationResponse"));
  }

  return response.translatedText;
}

async function translatePage(
  tabId: number,
  translationScope: TranslationScope,
) {
  await showInlineNotice(tabId, t("collectingPageText"), "loading");

  const settings = await getCurrentSettings();
  const profile = validateProfileForUse(getActiveProfile(settings));
  const translationSessionId = createPageTranslationSessionId(tabId);
  beginPageTranslationProgressSession(tabId, translationSessionId);

  try {
    const runtimeResult = await startPageTranslator(
      tabId,
      translationSessionId,
      translationScope,
      profile.provider,
      normalizeBuiltInTargetLanguageCode(settings.targetLanguage),
      settings.displayMode,
      settings.translationMode,
      settings.userWhitelist,
      settings.noTranslateSelectors,
      settings.minTranslationTextLength,
      profile.translationConcurrency,
      profile.translationBatchSegments,
      profile.translationBatchTextLength,
    );
    if (!runtimeResult?.collected) {
      throw new Error(t("pageTextNotFound"));
    }
  } catch (error) {
    clearPageTranslationProgressSession(tabId, translationSessionId);
    throw error;
  }
}

async function restoreTranslatedPage(tabId: number) {
  const [{ result: didRestore = false }] = await chrome.scripting.executeScript<[], boolean>({
    target: { tabId },
    func: restorePageOriginalText,
  });

  if (didRestore) {
    pageTranslationProgressSessions.delete(tabId);
  }

  return didRestore;
}

async function startPageTranslator(
  tabId: number,
  translationSessionId: string,
  translationScope: TranslationScope,
  translationProvider: TranslationProvider,
  targetLanguageCode: string,
  displayMode: TranslationDisplayMode,
  translationMode: TranslationMode,
  userWhitelist: string[],
  noTranslateSelectors: string[],
  minTranslationTextLength: number,
  translationConcurrency: number,
  translationBatchSegments: number,
  translationBatchTextLength: number,
) {
  await chrome.scripting.executeScript({
    target: { tabId },
    files: ["page-runtime.js"],
  });
  return chrome.tabs.sendMessage<{ collected?: boolean }>(tabId, {
    type: "open-translate:start-page-translator",
    maxNodesPerRound: MAX_TEXT_NODES_PER_ROUND,
    translationSessionId,
    translationScope,
    translationProvider,
    targetLanguageCode,
    displayMode,
    translationMode,
    userWhitelist,
    noTranslateSelectors,
    minTranslationTextLength,
    translationConcurrency,
    translationBatchSegments,
    translationBatchTextLength,
    builtInAiUnavailableMessage: t("builtInAiUnavailable"),
    builtInAiUnsupportedLanguagePairMessage: t("builtInAiUnsupportedLanguagePair"),
  });
}

function showPageTranslationProgress(
  tabId: number,
  translationSessionId: string,
  progress: TranslationProgress,
) {
  const session = getOrCreatePageTranslationProgressSession(tabId, translationSessionId);
  return session
    ? queuePageTranslationProgressNotice(tabId, session, progress)
    : Promise.resolve();
}

async function showPageTranslationComplete(tabId: number) {
  await showInlineNotice(tabId, t("pageTranslated"), "success");
  await chrome.contextMenus.update(PAGE_MENU_ID, {
    title: t("contextMenuShowOriginal"),
  });
}

async function getCurrentSettings(): Promise<TranslationSettings> {
  const stored = await chrome.storage.sync.get(null);
  const settings = normalizeSettings(stored);
  setAppLanguage(settings.appLanguage);
  return settings;
}

async function updateContextMenuTitles() {
  const settings = await getCurrentSettings();
  const targetLanguage = settings.targetLanguage || getDefaultTargetLanguage();

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
  const targetLanguage = settings.targetLanguage || getDefaultTargetLanguage();
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
  return defaultTargetLanguage;
}

async function translatePageTexts(
  texts: string[],
  tabId?: number,
  requestId?: string,
  translationSessionId?: string,
  progressCompleted = 0,
  progressTotal = 0,
) {
  const settings = await getCurrentSettings();
  const profile = validateProfileForUse(getActiveProfile(settings));
  if (profile.provider === "built-in-translator") {
    return {
      error: t("builtInAiRunsInPage"),
    };
  }
  const textItems = texts.map((text, index) => ({ index, text: text.trim() }))
    .filter((item) => item.text);

  if (!textItems.length) {
    return {
      translations: [],
      displayMode: settings.displayMode,
    };
  }

  const translations = await translateItems(
    textItems,
    (item) => item.text,
    profile,
    settings.targetLanguage,
    settings.userWhitelist,
    settings.minTranslationTextLength,
    settings.translationMode,
    profile.translationConcurrency,
    profile.translationBatchSegments,
    profile.translationBatchTextLength,
    settings.maxTranslationCacheEntries,
    tabId && translationSessionId
      ? createPageTranslationRequestProgress(
        tabId,
        translationSessionId,
        progressCompleted,
        progressTotal,
      ).update
      : undefined,
    async (translatedItems) => {
      if (tabId && requestId && translatedItems.length) {
        try {
          await chrome.tabs.sendMessage(tabId, {
            type: "open-translate:partial-page-translations",
            requestId,
            displayMode: settings.displayMode,
            translations: translatedItems.map(({ item, translatedText }) => ({
              index: item.index,
              text: translatedText,
            })),
          });
        } catch {
          // The final response still carries the translations if the runtime is reachable later.
        }
      }
    },
  );

  return {
    translations: rebuildTextTranslations(texts.length, textItems, translations),
    displayMode: settings.displayMode,
  };
}

function rebuildTextTranslations(
  total: number,
  items: Array<{ index: number }>,
  itemTranslations: string[],
) {
  const translations = new Array<string>(total).fill("");
  for (const [itemIndex, item] of items.entries()) {
    translations[item.index] = itemTranslations[itemIndex] || "";
  }

  return translations;
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
  targetLanguage: string,
  userWhitelist: string[],
  minTranslationTextLength: number,
  translationMode: TranslationMode,
  concurrency: number,
  maxBatchSegments: number,
  maxBatchTextLength: number,
  maxCacheEntries: number,
  onProgress?: (progress: TranslationProgress) => Promise<void>,
  onTranslations?: (
    translations: Array<{ item: T; translatedText: string }>,
  ) => Promise<void>,
) {
  const translations: string[] = new Array(items.length);
  let completed = 0;
  const entries = items.map((item, index) => ({
    index,
    item,
    sourceText: getSourceText(item),
  }));
  const translatableEntries: typeof entries = [];
  for (const entry of entries) {
    if (shouldSkipTranslation(entry.sourceText, userWhitelist, minTranslationTextLength)) {
      translations[entry.index] = "";
      completed += 1;
      continue;
    }

    translatableEntries.push(entry);
  }
  const batches = createTranslationBatches(
    translatableEntries,
    maxBatchSegments,
    maxBatchTextLength,
  );

  if (onProgress) {
    await onProgress({ completed, total: items.length });
  }

  if (batches.length) {
    await runConcurrent(
      batches,
      concurrency,
      async (batch) => {
        const cachedTranslations = await getCachedTranslations(
          batch.map((entry) => entry.sourceText),
          profile,
          targetLanguage,
          translationMode,
        );
        const cachedItems: Array<{ item: T; translatedText: string }> = [];
        const uncachedEntries: typeof entries = [];
        for (const [batchIndex, entry] of batch.entries()) {
          const cachedTranslation = cachedTranslations[batchIndex];
          if (!cachedTranslation) {
            uncachedEntries.push(entry);
            continue;
          }

          translations[entry.index] = cachedTranslation;
          cachedItems.push({ item: entry.item, translatedText: cachedTranslation });
        }

        if (cachedItems.length) {
          completed += cachedItems.length;
          await onTranslations?.(cachedItems);
          await onProgress?.({ completed, total: items.length });
        }

        if (!uncachedEntries.length) {
          return;
        }

        const translatedTexts = await translateTextBatch(
          uncachedEntries.map((entry) => entry.sourceText),
          profile,
          targetLanguage,
          userWhitelist,
          minTranslationTextLength,
          translationMode,
          maxCacheEntries,
        );

        const translatedItems: Array<{ item: T; translatedText: string }> = [];
        for (const [batchIndex, entry] of uncachedEntries.entries()) {
          const translatedText = translatedTexts[batchIndex];
          translations[entry.index] = translatedText;
          translatedItems.push({ item: entry.item, translatedText });
        }
        await onTranslations?.(translatedItems);

        completed += uncachedEntries.length;
        await onProgress?.({ completed, total: items.length });
      },
    );
  }

  return translations;
}

function createTranslationBatches<T>(
  entries: Array<{ index: number; item: T; sourceText: string }>,
  maxBatchSegments: number,
  maxBatchTextLength: number,
) {
  const batches: Array<Array<{ index: number; item: T; sourceText: string }>> = [];
  let batch: Array<{ index: number; item: T; sourceText: string }> = [];
  let batchTextLength = 0;

  for (const entry of entries) {
    const nextTextLength = batchTextLength + entry.sourceText.length;
    if (
      batch.length &&
      (batch.length >= maxBatchSegments || nextTextLength > maxBatchTextLength)
    ) {
      batches.push(batch);
      batch = [];
      batchTextLength = 0;
    }

    batch.push(entry);
    batchTextLength += entry.sourceText.length;
  }

  if (batch.length) {
    batches.push(batch);
  }

  return batches;
}

function createPageTranslationRequestProgress(
  tabId: number,
  translationSessionId: string,
  progressCompleted: number,
  progressTotal: number,
) {
  const session = getOrCreatePageTranslationProgressSession(tabId, translationSessionId);

  return {
    update(progress: TranslationProgress) {
      if (!session || !isCurrentPageTranslationSession(tabId, translationSessionId)) {
        return Promise.resolve();
      }

      return queuePageTranslationProgressNotice(tabId, session, {
        completed: Math.min(progressTotal, progressCompleted + progress.completed),
        total: progressTotal,
      });
    },
  };
}

function beginPageTranslationProgressSession(tabId: number, translationSessionId: string) {
  pageTranslationProgressSessions.set(tabId, {
    id: translationSessionId,
    noticeQueue: Promise.resolve(),
  });
}

function getOrCreatePageTranslationProgressSession(
  tabId: number,
  translationSessionId: string,
) {
  const existingSession = pageTranslationProgressSessions.get(tabId);
  if (existingSession?.id === translationSessionId) {
    return existingSession;
  }

  if (existingSession) {
    return undefined;
  }

  beginPageTranslationProgressSession(tabId, translationSessionId);
  return pageTranslationProgressSessions.get(tabId)!;
}

function clearPageTranslationProgressSession(tabId: number, translationSessionId: string) {
  if (isCurrentPageTranslationSession(tabId, translationSessionId)) {
    pageTranslationProgressSessions.delete(tabId);
  }
}

function isCurrentPageTranslationSession(tabId: number, translationSessionId: string) {
  return pageTranslationProgressSessions.get(tabId)?.id === translationSessionId;
}

function queuePageTranslationProgressNotice(
  tabId: number,
  session: PageTranslationProgressSession,
  progress: TranslationProgress,
) {
  session.noticeQueue = session.noticeQueue.then(() => {
    if (!isCurrentPageTranslationSession(tabId, session.id)) {
      return;
    }

    return showOptionalInlineNotice(
      tabId,
      t("translatingPageBatch", [String(progress.completed), String(progress.total)]),
      progress.completed < progress.total ? "loading" : "success",
    );
  });

  return session.noticeQueue;
}

function createPageTranslationSessionId(tabId: number) {
  return `page-${tabId}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
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
    // Page translation should continue even if a notice cannot render.
  }
}

function isPageTranslationActive() {
  const pageWindow = window as typeof window & {
    __openTranslatePageOriginals?: Map<Text, PageTextTranslation>;
    __openTranslatePageElementOriginals?: Map<Element, {
      sourceText: string;
      translatedText: string;
      originalHtml: string;
    }>;
  };

  return !!(
    pageWindow.__openTranslatePageOriginals?.size ||
    pageWindow.__openTranslatePageElementOriginals?.size
  );
}

function restorePageOriginalText() {
  const pageWindow = window as typeof window & {
    __openTranslatePageOriginals?: Map<Text, PageTextTranslation>;
    __openTranslatePageElementOriginals?: Map<Element, {
      sourceText: string;
      translatedText: string;
      originalHtml: string;
    }>;
    __openTranslatePageTranslator?: {
      observer: MutationObserver;
      removeScrollListener?: () => void;
    };
    __openTranslatePageSessionId?: number;
    __openTranslatePageTranslations?: Set<string>;
  };
  const originals = pageWindow.__openTranslatePageOriginals;
  const elementOriginals = pageWindow.__openTranslatePageElementOriginals;
  const bilingualTexts = document.querySelectorAll("[data-open-translate-bilingual='true']");
  const didRestore = !!originals?.size || !!elementOriginals?.size || bilingualTexts.length > 0;

  pageWindow.__openTranslatePageTranslator?.observer.disconnect();
  pageWindow.__openTranslatePageTranslator?.removeScrollListener?.();
  delete pageWindow.__openTranslatePageTranslator;

  for (const translatedText of bilingualTexts) {
    translatedText.remove();
  }

  for (const [element, translation] of elementOriginals || []) {
    if (element.isConnected) {
      element.innerHTML = translation.originalHtml;
      element.removeAttribute("data-open-translate-element");
    }
  }

  for (const [node, translation] of originals || []) {
    if (node.isConnected) {
      node.nodeValue = translation.sourceText;
    }
  }

  originals?.clear();
  elementOriginals?.clear();
  pageWindow.__openTranslatePageTranslations?.clear();
  delete pageWindow.__openTranslatePageOriginals;
  delete pageWindow.__openTranslatePageElementOriginals;
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
