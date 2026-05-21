import { getActiveProfile, normalizeSettings, validateProfileForUse } from '../shared/settings'
import type { TranslationDisplayMode, TranslationProfile, TranslationSettings } from '../shared/settings'

const MENU_ID = "open-translate";

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

const MAX_BATCH_CHARS = 6000;
const MAX_TEXT_NODES = 180;
const CACHE_KEY_PREFIX = "open-translate-cache";

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: MENU_ID,
    title: "翻译为目标语言",
    contexts: ["page", "selection"],
  });
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId !== MENU_ID || !tab?.id) {
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
    const message = error instanceof Error ? error.message : "翻译失败";
      await showInlineNotice(tab.id, message, "error");
  }
});

async function translateSelection(
  tabId: number,
  selectedText: string,
  profile: TranslationProfile,
  displayMode: TranslationDisplayMode,
) {
  await showInlineNotice(tabId, "正在翻译选中文本...", "loading");
  const translatedText = await translateText(selectedText, profile);

  const [{ result: didShow }] = await chrome.scripting.executeScript({
    target: { tabId },
    func: renderSelectionTranslationPanel,
    args: [selectedText, translatedText, displayMode],
  });

  await showInlineNotice(
    tabId,
    didShow ? "选中文本已翻译" : "没有找到可显示的选中文本",
    didShow ? "success" : "error",
  );
}

async function translatePage(
  tabId: number,
  profile: TranslationProfile,
  displayMode: TranslationDisplayMode,
) {
  await showInlineNotice(tabId, "正在收集页面文本...", "loading");

  const [{ result: textNodes = [] }] = await chrome.scripting.executeScript<
    [number],
    PageTextNode[]
  >({
    target: { tabId },
    func: collectPageTextNodes,
    args: [MAX_TEXT_NODES],
  });

  if (!textNodes.length) {
    throw new Error("当前页面没有可翻译的可见文本");
  }

  const batches = createBatches(textNodes, MAX_BATCH_CHARS);
  let completed = 0;

  for (const batch of batches) {
    await showInlineNotice(
      tabId,
      `正在翻译整页内容 ${completed + 1}/${batches.length}...`,
      "loading",
    );

    const translatedItems = await translateTextList(
      batch.map((item) => item.text),
      profile,
    );

    const replacements = batch.map((item, index) => ({
      path: item.path,
      sourceText: item.text,
      text: translatedItems[index] || item.text,
    }));

    await chrome.scripting.executeScript({
      target: { tabId },
      func: replacePageTextNodes,
      args: [replacements, displayMode],
    });

    completed += 1;
  }

  await showInlineNotice(tabId, "整页翻译完成", "success");
}

async function getCurrentSettings(): Promise<TranslationSettings> {
  const stored = await chrome.storage.sync.get(null);
  return normalizeSettings(stored);
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
    throw new Error("接口没有返回可用的翻译结果");
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

你会收到一个 JSON 字符串数组。请逐项翻译数组中的文本，并只返回 JSON 字符串数组。
要求：
1. 返回数组长度必须与输入一致。
2. 不要返回 Markdown，不要包裹代码块。
3. 保留数字、URL、邮箱、代码片段和多余空白。`,
    },
    { role: "user", content: JSON.stringify(missingItems.map((item) => item.text)) },
  ]);

  const rawContent = payload?.choices?.[0]?.message?.content?.trim();
  if (!rawContent) {
    throw new Error("接口没有返回可用的翻译结果");
  }

  const parsed = parseJsonArray(rawContent);
  if (!Array.isArray(parsed) || parsed.length !== missingItems.length) {
    throw new Error("接口返回的整页翻译格式不正确");
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
    throw new Error(`接口请求失败：${detail}`);
  }

  return payload;
}

function getSystemPrompt(profile: TranslationProfile) {
  return (
    profile.customPrompt.trim() ||
    `你是专业翻译助手。请将用户提供的文本翻译为${profile.targetLanguage}，保留原文格式、专有名词和代码块。只输出译文，不要解释。`
  );
}

function parseJsonArray(content: string): unknown {
  try {
    return JSON.parse(content);
  } catch {
    const match = content.match(/\[[\s\S]*\]/);
    if (!match) {
      throw new Error("接口返回的整页翻译格式不正确");
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

function createBatches(items: PageTextNode[], maxChars: number) {
  const batches: PageTextNode[][] = [];
  let currentBatch: PageTextNode[] = [];
  let currentChars = 0;

  for (const item of items) {
    const itemChars = item.text.length;
    if (currentBatch.length && currentChars + itemChars > maxChars) {
      batches.push(currentBatch);
      currentBatch = [];
      currentChars = 0;
    }

    currentBatch.push(item);
    currentChars += itemChars;
  }

  if (currentBatch.length) {
    batches.push(currentBatch);
  }

  return batches;
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
    const node = getNodeByPath(replacement.path);
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
    const wrapper = document.createElement("span");
    wrapper.dataset.openTranslateBilingual = "true";
    wrapper.textContent = translatedText;
    wrapper.style.cssText = `
      display: inline;
      margin-left: 0.35em;
      color: #2563eb;
      font: inherit;
      opacity: 0.96;
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
}

function renderSelectionTranslationPanel(
  sourceText: string,
  translatedText: string,
  displayMode: "translation" | "bilingual",
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
  closeButton.title = "关闭";
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
