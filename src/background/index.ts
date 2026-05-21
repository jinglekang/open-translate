import { getActiveProfile, normalizeSettings, validateProfileForUse } from '../shared/settings'
import type { TranslationProfile } from '../shared/settings'

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

type TextReplacement = PageTextNode;

const MAX_BATCH_CHARS = 6000;
const MAX_TEXT_NODES = 180;

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
    const profile = validateProfileForUse(await getCurrentProfile());

    const selectedText = (info.selectionText || "").trim();
    if (selectedText) {
      await translateSelection(tab.id, selectedText, profile);
      return;
    }

    await translatePage(tab.id, profile);
  } catch (error) {
    const message = error instanceof Error ? error.message : "翻译失败";
    await showInlineNotice(tab.id, message, true);
  }
});

async function translateSelection(
  tabId: number,
  selectedText: string,
  profile: TranslationProfile,
) {
  await showInlineNotice(tabId, "正在翻译选中文本...", false);
  const translatedText = await translateText(selectedText, profile);

  const [{ result: didReplace }] = await chrome.scripting.executeScript({
    target: { tabId },
    func: replaceCurrentSelection,
    args: [translatedText],
  });

  await showInlineNotice(
    tabId,
    didReplace ? "选中文本已翻译" : "没有找到可替换的选中文本",
    !didReplace,
  );
}

async function translatePage(tabId: number, profile: TranslationProfile) {
  await showInlineNotice(tabId, "正在收集页面文本...", false);

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
      false,
    );

    const translatedItems = await translateTextList(
      batch.map((item) => item.text),
      profile,
    );

    const replacements = batch.map((item, index) => ({
      path: item.path,
      text: translatedItems[index] || item.text,
    }));

    await chrome.scripting.executeScript({
      target: { tabId },
      func: replacePageTextNodes,
      args: [replacements],
    });

    completed += 1;
  }

  await showInlineNotice(tabId, "整页翻译完成", false);
}

async function getCurrentProfile(): Promise<TranslationProfile> {
  const stored = await chrome.storage.sync.get(null);
  const settings = normalizeSettings(stored);
  return getActiveProfile(settings);
}

async function translateText(sourceText: string, profile: TranslationProfile) {
  const payload = await requestChatCompletions(profile, [
    { role: "system", content: getSystemPrompt(profile) },
    { role: "user", content: sourceText },
  ]);

  const translatedText = payload?.choices?.[0]?.message?.content?.trim();
  if (!translatedText) {
    throw new Error("接口没有返回可用的翻译结果");
  }

  return translatedText;
}

async function translateTextList(texts: string[], profile: TranslationProfile) {
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
    { role: "user", content: JSON.stringify(texts) },
  ]);

  const rawContent = payload?.choices?.[0]?.message?.content?.trim();
  if (!rawContent) {
    throw new Error("接口没有返回可用的翻译结果");
  }

  const parsed = parseJsonArray(rawContent);
  if (!Array.isArray(parsed) || parsed.length !== texts.length) {
    throw new Error("接口返回的整页翻译格式不正确");
  }

  return parsed.map((item) => String(item));
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

async function showInlineNotice(tabId: number, message: string, isError: boolean) {
  await chrome.scripting.executeScript({
    target: { tabId },
    func: renderInlineNotice,
    args: [message, isError],
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

        if (parent.closest("[contenteditable='true'], [data-open-translate-ui]")) {
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

function replacePageTextNodes(replacements: TextReplacement[]) {
  for (const replacement of replacements) {
    const node = getNodeByPath(replacement.path);
    if (node?.nodeType === Node.TEXT_NODE) {
      node.nodeValue = replacement.text;
    }
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

function replaceCurrentSelection(translatedText: string) {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0) {
    return false;
  }

  const range = selection.getRangeAt(0);
  range.deleteContents();
  range.insertNode(document.createTextNode(translatedText));
  selection.removeAllRanges();
  return true;
}

function renderInlineNotice(message: string, isError: boolean) {
  document.querySelector("[data-open-translate-ui]")?.remove();

  const notice = document.createElement("div");
  notice.dataset.openTranslateUi = "true";
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
  window.setTimeout(() => notice.remove(), isError ? 6000 : 2200);
}
