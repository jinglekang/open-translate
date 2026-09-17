// Run after pnpm build. Optional argument: a local HTML fixture (never sent online).
// BROWSER_PATH can point to a Chromium executable on other systems.
import assert from 'node:assert/strict'
import { spawn, execFileSync } from 'node:child_process'
import { existsSync, readFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { once } from 'node:events'
import ts from 'typescript'

const browserPath = process.env.BROWSER_PATH || [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
].find(existsSync)
assert.ok(browserPath, 'Set BROWSER_PATH to a Chromium executable')
const runtime = process.env.VERIFY_BASELINE
  ? ts.transpileModule(execFileSync('git', ['show', 'HEAD:src/page/runtime.ts'], { encoding: 'utf8' }), {
    compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.None },
  }).outputText
  : readFileSync(new URL('../dist/page-runtime.js', import.meta.url), 'utf8')
const suppliedHtml = process.argv[2] ? readFileSync(process.argv[2], 'utf8') : ''
const profile = mkdtempSync(join(tmpdir(), 'open-translate-dom-'))
const browser = spawn(browserPath, [
  '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank',
], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] })
let socket
try {
  const endpoint = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Browser startup timed out')), 20000)
    let log = ''
    browser.stderr.on('data', (chunk) => {
      log += chunk
      const match = log.match(/DevTools listening on (ws:\/\/\S+)/)
      if (match) { clearTimeout(timer); resolve(match[1]) }
    })
    browser.once('error', (error) => { clearTimeout(timer); reject(error) })
    browser.once('exit', () => { clearTimeout(timer); reject(new Error('Browser exited early')) })
  })
  socket = new WebSocket(endpoint)
  await once(socket, 'open')
  let nextId = 0
  const pending = new Map()
  socket.addEventListener('message', ({ data }) => {
    const message = JSON.parse(data)
    const callback = pending.get(message.id)
    if (!callback) return
    pending.delete(message.id)
    if (message.error) callback.reject(new Error(message.error.message))
    else callback.resolve(message.result)
  })
  function send(method, params = {}, sessionId) {
    return new Promise((resolve, reject) => {
      const id = ++nextId
      pending.set(id, { resolve, reject })
      socket.send(JSON.stringify({ id, method, params, sessionId }))
    })
  }
  for (const [translationMode, displayMode, failure] of [
    ['element-context', 'translation'], ['element-context', 'bilingual'], ['text-node', 'translation'],
    ['element-context', 'translation', '401 Unauthorized'],
    ['element-context', 'translation', '403 Forbidden'],
    ['element-context', 'translation', 'connection'],
    ['element-context', 'translation', 'empty'],
  ]) {
    const { targetId } = await send('Target.createTarget', { url: 'about:blank' })
    const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true })
    const evaluate = async (expression) => {
      const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sessionId)
      assert.ok(!result.exceptionDetails, result.exceptionDetails?.exception?.description)
      return result.result.value
    }
    await send('Network.enable', {}, sessionId)
    await send('Network.setBlockedURLs', { urls: ['http://*', 'https://*'] }, sessionId)
    await evaluate(`(${setup.toString()})(${JSON.stringify(suppliedHtml)}, ${JSON.stringify(displayMode)})`)
    if (failure) await evaluate(`window.failure = ${JSON.stringify(failure)}`)
    await evaluate(runtime)
    await evaluate(`window.startTranslation(${JSON.stringify(translationMode)}, ${JSON.stringify(displayMode)})`)
    if (failure) {
      const result = await evaluate(`(${verifyFailure.toString()})()`)
      const expectedError = failure === 'connection' ? 'Connection lost' : failure === 'empty' ? '' : failure
      assert.equal(result.error, expectedError, 'Page must forward the original error')
      assert.equal(result.completed, false, 'Failed translation must not report success')
      assert.equal(result.requestsBefore, result.requestsAfter, 'Failed session must stop automatic requests')
      console.log(`PASS page error / ${failure}`)
      await send('Target.closeTarget', { targetId })
      continue
    }
    const result = await evaluate(`(${verify.toString()})()`)
    assert.ok(result.noHiddenRequests, 'Hidden menu/dialog/CSS text was sent for translation')
    assert.ok(result.structurePreserved, 'An original link, control, or container was replaced')
    assert.ok(result.hiddenStillHidden, 'Closed dialog or popover became visible')
    assert.equal(result.clicks, 1, 'Original link listener must still work')
    assert.ok(result.linkPreserved, 'Link href or text translation was lost')
    assert.ok(result.visibleTranslated, 'Visible heading text was not translated')
    assert.ok(result.codePreserved, 'Protected inline code was lost')
    if (translationMode === 'element-context') {
      assert.ok(result.paragraphTranslatedAsElement, 'Plain paragraph lost whole-paragraph translation')
    }
    console.log(`PASS ${translationMode} / ${displayMode}${suppliedHtml ? ' + supplied DOM' : ''}`)
    await send('Target.closeTarget', { targetId })
  }
} finally {
  socket?.close()
  browser.kill()
  // Keep the isolated browser profile for diagnosis; never use the user's profile.
  console.log(`Temporary browser profile: ${profile}`)
}

function setup(suppliedHtml, displayMode) {
  document.body.innerHTML = `<style>
    .sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); }
    .d-flex { display: flex; } .css-hidden { display: none; } .transparent { opacity: 0; }
  </style><section id="supplied">${suppliedHtml}</section>
  <section id="complex"><h3><span><a href="/repository">Repository link</a> released</span>
    <div><button popovertarget="menu">Options</button>
      <div id="menu" popover>Hidden menu text</div>
      <dialog>Hidden dialog text<label><input type="checkbox">Hidden checkbox label</label></dialog>
    </div></h3>
    <p>Read <a href="/docs">Documentation</a> for details.</p>
    <p>Visible label<span class="css-hidden">Hidden CSS text</span></p>
    <p>Visible caption<span class="sr-only">Hidden screen-reader text</span></p>
    <div class="transparent"><p>Hidden ancestor text</p></div>
  </section><p id="plain">Use <code>npm install</code> to install.</p>`
  const roots = [...document.querySelectorAll('#supplied *, #complex *')]
  window.originalElements = roots
  window.clicks = 0
  window.link = document.querySelector('#complex a')
  window.link.addEventListener('click', (event) => { event.preventDefault(); window.clicks++ })
  window.requests = []
  window.messages = []
  let listener
  const mockTranslate = (text) => `译文 ${text.replace('released', '已发布')}`
  window.chrome = { runtime: {
    onMessage: { addListener: (value) => { listener = value } },
    sendMessage: (message, callback) => {
      window.messages.push(message)
      if (message.type === 'open-translate:translate-texts') {
        window.requests.push(...message.texts)
        setTimeout(() => {
          if (window.failure === 'connection') {
            window.chrome.runtime.lastError = { message: 'Connection lost' }
            callback(undefined)
            delete window.chrome.runtime.lastError
          } else if (window.failure === 'empty') {
            callback(undefined)
          } else if (window.failure) {
            callback({ error: window.failure })
          } else {
            callback({ translations: message.texts.map(mockTranslate), displayMode })
          }
        }, 0)
      }
    },
  } }
  window.startTranslation = (translationMode, mode) => listener({
    type: 'open-translate:start-page-translator', maxNodesPerRound: 500,
    translationSessionId: 'regression', translationScope: 'visible-page',
    translationProvider: 'openai-compatible', targetLanguageCode: 'zh', displayMode: mode,
    translationMode, userWhitelist: [], noTranslateSelectors: ['code', 'pre', '[contenteditable="true"]'],
    minTranslationTextLength: 2, translationConcurrency: 4, translationBatchSegments: 4,
    translationBatchTextLength: 1200, builtInAiUnavailableMessage: '', builtInAiUnsupportedLanguagePairMessage: '',
  }, {}, () => {})
}

async function verify() {
  for (let i = 0; i < 200; i++) {
    if (window.messages.some((message) => message.type === 'open-translate:initial-page-translation-complete')) break
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  if (!window.messages.some((message) => message.type === 'open-translate:initial-page-translation-complete')) {
    throw new Error('Translation did not complete')
  }
  window.link.click()
  const hiddenText = /Hidden |Show less activity|Send feedback|Tell us more|I'm not interested|I want to see fewer|Submit/
  return {
    noHiddenRequests: window.requests.every((text) => !hiddenText.test(text)),
    structurePreserved: window.originalElements.every((element) => element.isConnected),
    hiddenStillHidden: [...document.querySelectorAll('dialog, [popover]')].every((el) => !el.getClientRects().length),
    clicks: window.clicks,
    linkPreserved: window.link.getAttribute('href') === '/repository' && window.link.textContent.includes('译文'),
    visibleTranslated: document.querySelector('#complex h3').textContent.includes('已发布'),
    codePreserved: document.querySelector('#plain code')?.textContent === 'npm install',
    paragraphTranslatedAsElement: document.querySelector('#plain').dataset.openTranslateElement === 'true',
  }
}

async function verifyFailure() {
  for (let i = 0; i < 200; i++) {
    if (window.messages.some((message) => message.type === 'open-translate:page-translation-error')) break
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  const error = window.messages.find((message) => message.type === 'open-translate:page-translation-error')
  if (!error) throw new Error('Page swallowed the translation error')
  const requestsBefore = window.requests.length
  const paragraph = document.createElement('p')
  paragraph.textContent = 'New content after failure'
  document.body.append(paragraph)
  document.dispatchEvent(new Event('scroll'))
  await new Promise((resolve) => setTimeout(resolve, 800))
  return {
    error: error.message,
    completed: window.messages.some((message) => message.type === 'open-translate:initial-page-translation-complete'),
    requestsBefore,
    requestsAfter: window.requests.length,
  }
}
