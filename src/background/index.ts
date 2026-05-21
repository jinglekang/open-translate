import { t } from '../shared/i18n'
import { getActiveProfile, normalizeSettings, validateProfileForUse } from '../shared/settings'
import type { TranslationDisplayMode, TranslationProfile, TranslationSettings } from '../shared/settings'

const PAGE_MENU_ID = "open-translate-page";
const SELECTION_MENU_ID = "open-translate-selection";

type ChatMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

type ChatCompletionsPayload = {
  choices?: Array<{
    message?: {
      content?: string;
    };
  }>;
  error?: {
    message?: string;
  };
  message?: string;
};

type PageTextNode = {
  path: number[];
  text: string;
};

type TextReplacement = {
  path: number[];
  sourceText: string;
  text: string;
};

type DynamicTranslateMessage = {
  type: "open-translate:translate-texts";
  texts: string[];
};

const MAX_TEXT_NODES = 180;
const PAGE_TRANSLATION_CONCURRENCY = 4;
const CACHE_KEY_PREFIX = "open-translate-cache";

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: PAGE_MENU_ID,
    title: t("contextMenuTranslate"),
    contexts: ["page"],
  });
  chrome.contextMenus.create({
    id: SELECTION_MENU_ID,
    title: t("contextMenuTranslateSelection"),
    contexts: ["selection"],
  });
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (
    (info.menuItemId !== PAGE_MENU_ID && info.menuItemId !== SELECTION_MENU_ID) ||
    !tab?.id
  ) {
    return;
  }

  try {
    const settings = await getCurrentSettings();
    const profile = validateProfileForUse(getActiveProfile(settings));

    const selectedText = (info.selectionText || "").trim();
    if (selectedText) {
      await translateSelection(tab.id, selectedText, profile, settings.displayMode);
      return;
    }

    await translatePage(tab.id, profile, settings.displayMode);
  } catch (error) {
    const message = error instanceof Error ? error.message : t("translationFailed");
      await showInlineNotice(tab.id, message, "error");
  }
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!isDynamicTranslateMessage(message)) {
    return false;
  }

  void translateDynamicTexts(message.texts)
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
) {
  await showInlineNotice(tabId, t("collectingPageText"), "loading");

  const [{ result: textNodes = [] }] = await chrome.scripting.executeScript<
    [number],
    PageTextNode[]
  >({
    target: { tabId },
    func: collectPageTextNodes,
    args: [MAX_TEXT_NODES],
  });

  if (!textNodes.length) {
    throw new Error(t("pageTextNotFound"));
  }

  let completed = 0;
  await runConcurrent(textNodes, PAGE_TRANSLATION_CONCURRENCY, async (item) => {
    const translatedText = await translateText(item.text, profile);
    await chrome.scripting.executeScript({
      target: { tabId },
      func: replacePageTextNodes,
      args: [[{
        path: item.path,
        sourceText: item.text,
        text: translatedText || item.text,
      }], displayMode],
    });

    completed += 1;
    await showInlineNotice(
      tabId,
      t("translatingPageBatch", [String(completed), String(textNodes.length)]),
      "loading",
    );
  });

  await showInlineNotice(tabId, t("pageTranslated"), "success");
  await chrome.scripting.executeScript({
    target: { tabId },
    func: installDynamicPageTranslator,
    args: [MAX_TEXT_NODES],
  });
}

async function getCurrentSettings(): Promise<TranslationSettings> {
  const stored = await chrome.storage.sync.get(null);
  return normalizeSettings(stored);
}

async function translateDynamicTexts(texts: string[]) {
  const settings = await getCurrentSettings();
  const profile = validateProfileForUse(getActiveProfile(settings));
  const normalizedTexts = texts.map((text) => text.trim()).filter(Boolean);

  if (!normalizedTexts.length) {
    return {
      translations: [],
      displayMode: settings.displayMode,
    };
  }

  return {
    translations: await translateTextList(normalizedTexts, profile),
    displayMode: settings.displayMode,
  };
}

async function translateText(sourceText: string, profile: TranslationProfile) {
  const cachedTranslation = await getCachedTranslation(sourceText, profile);
  if (cachedTranslation) {
    return cachedTranslation;
  }

  const payload = await requestChatCompletions(profile, [
    { role: "system", content: getSystemPrompt(profile) },
    { role: "user", content: sourceText },
  ]);

  const translatedText = payload?.choices?.[0]?.message?.content?.trim();
  if (!translatedText) {
    throw new Error(t("emptyTranslationResponse"));
  }

  await cacheTranslation(sourceText, translatedText, profile);
  return translatedText;
}

async function translateTextList(texts: string[], profile: TranslationProfile) {
  const cachedTranslations = await getCachedTranslations(texts, profile);
  const missingItems = cachedTranslations
    .map((translation, index) => ({
      index,
      text: texts[index],
      translation,
    }))
    .filter((item) => !item.translation);

  if (!missingItems.length) {
    return cachedTranslations as string[];
  }

  const payload = await requestChatCompletions(profile, [
    {
      role: "system",
      content: `${getSystemPrompt(profile)}

You will receive a JSON string array. Translate each item in the array and return only a JSON string array.
Requirements:
1. The returned array length must exactly match the input array length.
2. Do not return Markdown or wrap the result in a code block.
3. Preserve numbers, URLs, email addresses, code snippets, and extra whitespace.`,
    },
    { role: "user", content: JSON.stringify(missingItems.map((item) => item.text)) },
  ]);

  const rawContent = payload?.choices?.[0]?.message?.content?.trim();
  if (!rawContent) {
    throw new Error(t("emptyTranslationResponse"));
  }

  const parsed = parseJsonArray(rawContent);
  if (!Array.isArray(parsed) || parsed.length !== missingItems.length) {
    throw new Error(t("invalidBatchResponse"));
  }

  const translatedMissingItems = parsed.map((item) => String(item));
  const results = [...cachedTranslations];

  for (const [missingIndex, translatedText] of translatedMissingItems.entries()) {
    const item = missingItems[missingIndex];
    results[item.index] = translatedText;
  }

  await cacheTranslations(
    missingItems.map((item, index) => ({
      sourceText: item.text,
      translatedText: translatedMissingItems[index],
    })),
    profile,
  );

  return results as string[];
}

async function getCachedTranslation(sourceText: string, profile: TranslationProfile) {
  const [translation] = await getCachedTranslations([sourceText], profile);
  return translation;
}

async function getCachedTranslations(texts: string[], profile: TranslationProfile) {
  const cacheKeys = await Promise.all(texts.map((text) => createTranslationCacheKey(text, profile)));
  const cachedItems = await chrome.storage.local.get(cacheKeys);

  return cacheKeys.map((cacheKey) => {
    const cachedValue = cachedItems[cacheKey];
    return typeof cachedValue === "string" ? cachedValue : undefined;
  });
}

async function cacheTranslation(
  sourceText: string,
  translatedText: string,
  profile: TranslationProfile,
) {
  await cacheTranslations([{ sourceText, translatedText }], profile);
}

async function cacheTranslations(
  items: Array<{ sourceText: string; translatedText: string }>,
  profile: TranslationProfile,
) {
  const entries = await Promise.all(
    items.map(async (item) => [
      await createTranslationCacheKey(item.sourceText, profile),
      item.translatedText,
    ]),
  );

  await chrome.storage.local.set(Object.fromEntries(entries));
}

async function createTranslationCacheKey(sourceText: string, profile: TranslationProfile) {
  const cacheInput = JSON.stringify({
    version: 1,
    profile: {
      endpoint: getChatCompletionsEndpoint(profile.apiBaseUrl),
      model: profile.model,
      targetLanguage: profile.targetLanguage,
      customPrompt: profile.customPrompt,
    },
    sourceText,
  });
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(cacheInput),
  );
  const hash = [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");

  return `${CACHE_KEY_PREFIX}:${hash}`;
}

async function requestChatCompletions(
  profile: TranslationProfile,
  messages: ChatMessage[],
): Promise<ChatCompletionsPayload> {
  const endpoint = getChatCompletionsEndpoint(profile.apiBaseUrl);
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${profile.apiKey}`,
    },
    body: JSON.stringify({
      model: profile.model,
      messages,
      temperature: 0.2,
    }),
  });

  const payload = await response.json().catch(() => null);

  if (!response.ok) {
    const detail =
      payload?.error?.message ||
      payload?.message ||
      `${response.status} ${response.statusText}`;
    throw new Error(t("apiRequestFailed", detail));
  }

  return payload;
}

function getSystemPrompt(profile: TranslationProfile) {
  return (
    profile.customPrompt.trim() ||
    `You are a professional translation assistant. Translate the user's text into ${profile.targetLanguage}. Preserve the original formatting, proper nouns, and code blocks. Output only the translation without explanations.`
  );
}

function parseJsonArray(content: string): unknown {
  try {
    return JSON.parse(content);
  } catch {
    const match = content.match(/\[[\s\S]*\]/);
    if (!match) {
      throw new Error(t("invalidBatchResponse"));
    }

    return JSON.parse(match[0]);
  }
}

function getChatCompletionsEndpoint(apiBaseUrl: string) {
  const normalized = apiBaseUrl.trim().replace(/\/+$/, "");
  if (normalized.endsWith("/chat/completions")) {
    return normalized;
  }

  return `${normalized}/chat/completions`;
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

function collectPageTextNodes(maxNodes: number) {
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
) {
  const orderedReplacements =
    displayMode === "bilingual"
      ? [...replacements].sort((left, right) => compareNodePathDesc(left.path, right.path))
      : replacements;

  for (const replacement of orderedReplacements) {
    const node = getReplacementTextNode(replacement);
    if (node?.nodeType === Node.TEXT_NODE) {
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

function installDynamicPageTranslator(maxNodes: number) {
  type DynamicState = {
    observer: MutationObserver;
  };
  type DynamicResponse = {
    translations?: string[];
    displayMode?: "translation" | "bilingual";
    error?: string;
  };

  const windowWithTranslator = window as typeof window & {
    __openTranslateDynamicTranslator?: DynamicState;
  };
  windowWithTranslator.__openTranslateDynamicTranslator?.observer.disconnect();

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
  windowWithTranslator.__openTranslateDynamicTranslator = { observer };

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
    if (isTranslatableTextNode(node)) {
      pendingNodes.add(node);
    }
  }

  function scheduleFlush() {
    window.clearTimeout(debounceTimer);
    debounceTimer = window.setTimeout(flushPendingNodes, 650);
  }

  function flushPendingNodes() {
    const nodes = [...pendingNodes].filter(isTranslatableTextNode).slice(0, maxNodes);
    pendingNodes.clear();

    if (!nodes.length) {
      return;
    }

    const sourceTexts = nodes.map((node) => node.nodeValue || "");
    chrome.runtime.sendMessage(
      { type: "open-translate:translate-texts", texts: sourceTexts },
      (response) => {
        const dynamicResponse = response as DynamicResponse | undefined;
        if (
          chrome.runtime.lastError ||
          dynamicResponse?.error ||
          !dynamicResponse?.translations
        ) {
          return;
        }

        isApplyingTranslation = true;
        try {
          for (const [index, node] of nodes.entries()) {
            const translatedText = dynamicResponse.translations[index];
            if (!translatedText || !node.parentNode || !isTranslatableTextNode(node)) {
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
      },
    );
  }

  function applyDynamicTranslation(
    node: Text,
    sourceText: string,
    translatedText: string,
    displayMode: "translation" | "bilingual",
  ) {
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

    if (!parent || ignoredTags.has(parent.tagName)) {
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
      style.visibility !== "hidden" &&
      style.display !== "none" &&
      Number(style.opacity) !== 0
    );
  }
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
