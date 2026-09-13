# Архітектура

Технічна довідка для розширення `extension/` — контексти виконання,
повідомлення між ними, схема `chrome.storage.local`, і як додавати нову
функціональність (не лише відео), не порушуючи гарантій безпеки з
`README.md`.

## Контексти виконання

Розширення складається з чотирьох незалежних JS-контекстів. Кожен має
доступ лише до свого підмножини API — це і визначає, чому логіка
розкидана саме так:

| Контекст            | Файл             | Що має                                   | Чого не має |
|---------------------|------------------|-------------------------------------------|-------------|
| Content script       | `content.js`     | DOM сторінки, `fetch()` у контексті сторінки | `chrome.downloads`, `chrome.offscreen`, `chrome.power` |
| Service worker       | `background.js`  | `chrome.tabs`, `chrome.downloads`, `chrome.power`, `chrome.scripting` | DOM, `Blob`/`URL.createObjectURL` |
| Offscreen document   | `offscreen.js`   | DOM (тому й `Blob`/`URL.createObjectURL`) | `chrome.downloads` (перевірено емпірично — недоступний) |
| Popup                | `popup.js`       | DOM popup'а, `chrome.tabs`, `chrome.storage` | живе, лише поки відкритий (закривається при втраті фокусу — клік по сторінці, нова вкладка тощо) |

Звідси й ключове архітектурне правило: **будь-яка дія, що має пережити
закриття popup (завантаження, пайплайн), має виконуватись і зберігати
стан у `background.js`/`chrome.storage.local`, а не в `popup.js`.** Popup
лише читає storage і показує його; тригерить дії короткими
повідомленнями.

## Потік виконання одного сценарію (`RUN_SCENARIO`)

```
popup.js → chrome.tabs.sendMessage(tabId, {type:"RUN_SCENARIO", scenario})
         → content.js: runScenario() виконує steps послідовно,
           шукає ACTIONS[step.action], збирає variables
         → sendResponse({success, variables} | {success:false, error})
```

Якщо `chrome.tabs.sendMessage` кидає помилку (content script ще не
заінжектований — вкладка була відкрита до перезавантаження розширення),
викликається fallback: `chrome.scripting.executeScript({files:["content.js"]})`
і повторний `sendMessage`. Цей патерн повторюється в кількох місцях
(`popup.js` і `background.js`) під назвою `sendToContentScript`.

`content.js` захищений від подвійної ін'єкції гардом
`if (!window.__videoRunnerLoaded) { window.__videoRunnerLoaded = true; (function(){ ... })(); }`
— без цього повторна ін'єкція (декларативна + fallback) кидає
`SyntaxError: Identifier 'ACTIONS' has already been declared`.

## Сесії та пайплайн (`collectLinks` → `downloadHLS`)

Це найскладніша частина, і саме вона — приклад патерну для майбутніх
довготривалих дій (не тільки відео).

### Модель сесії

Одна **сесія** = один запуск `collectLinks` на одній сторінці. У popup
кожна сесія — окрема вкладка (`sessions[]` у `chrome.storage.local`):

```js
{ id, label, videos: [{ index, title, url, selected, progress? }] }
```

`id` генерується в popup (`generateSessionId()`) і надалі називається
**`pipelineSessionId`** — саме він проходить крізь усі повідомлення
нижче, щоб прив'язати прогрес/статус до правильної вкладки в UI.

### Запуск завантаження (`START_PIPELINE`)

```
popup.js:  chrome.runtime.sendMessage({
             type: "START_PIPELINE",
             pipelineSessionId, videos /* лише selected */, concurrency
           })

background.js: runPipelineAllVideos(pipelineSessionId, videos, concurrency)
  - pipelineControls: Map<pipelineSessionId, {paused, stopped, currentTabIds}>
  - worker-пул (за замовчуванням 3): кожен worker бере наступне відео,
    відкриває chrome.tabs.create({active:false}), чекає onUpdated "complete",
    шле RUN_SCENARIO зі steps:[{action:"downloadHLS", pipelineSessionId,
    videoUrl, title}], закриває вкладку, повторює
  - між workers — 300мс зсув старту, щоб не бити по серверу одночасно
  - Pause/Resume/Stop — через ці ж pipelineControls, перевіряються між
    відео (і на старті кожного) в циклі worker()
  - chrome.power.requestKeepAwake("system") з лічильником
    activePipelineCount (кілька сесій можуть якісно ділити один keep-awake)
```

`PIPELINE_STOP` додатково ставить **запобіжний `setTimeout` на 8с**: якщо
сесія сама не встигла коректно завершитись (канал до вкладки не порвався
вчасно) — примусово фіналізує (`forced: true` в фінальному статусі), щоб
UI не висів на "Stopping..." нескінченно.

### Прогрес одного відео (`downloadHLS` → `HLS_PROGRESS`)

`content.js`'s `downloadHLS` шле `chrome.runtime.sendMessage({type:
"HLS_PROGRESS", stage, video, videoUrl, pipelineSessionId, ...})` на
кожному етапі (`start`, `detect-m3u8`, `playlist`, `master-playlist`,
`variant-selected`, `init`, `segment` (з `segment`/`totalSegments`),
`retry`, `saving`, `done`). `videoUrl` — це `step.videoUrl`, яким
позначається, до якого саме відео зі списку належить цей прогрес (бо
`title` не гарантовано унікальний).

`background.js` ловить кожне `HLS_PROGRESS` і кладе в
`chrome.storage.local["sessionProgress"][pipelineSessionId]` (масив,
обрізаний до 200 останніх записів). `popup.js` підписаний через
`chrome.storage.onChanged` — якщо змінена сесія збігається з активною
вкладкою в popup, перераховує прогрес-бар для конкретного відео
(`applyProgressToSession`, зіставлення за `entry.videoUrl`/`entry.url`) і
перерендерює чекбокс-список.

### Збереження файлу (`SAVE_CHUNK` → `SAVE_FILE_FINALIZE`)

Сегменти якосно НЕ передаються одним великим повідомленням — Chrome має
практичну межу розміру повідомлення (~64МБ), і одна спроба передати весь
файл одразу призводила до тихого збою ("2 байти" файл). Замість цього:

```
content.js: після кожного сегмента —
  chrome.runtime.sendMessage({type:"SAVE_CHUNK", sessionId, index,
    base64: arrayBufferToBase64(buffer)})
    (sessionId тут — ЛОКАЛЬНИЙ id завантаження файлу, окремий від
     pipelineSessionId; це просто ключ для збірки Blob, не має
     стосунку до UI-сесій)

background.js: appendChunk() → ensureOffscreenDocument() →
  ретранслює APPEND_CHUNK в offscreen.js (там зберігається у Map
  sessionId → Uint8Array[])

content.js: наприкінці — SAVE_FILE_FINALIZE {sessionId, filename, mimeType}
background.js: finalizeFile() → шле FINALIZE_BLOB в offscreen.js
offscreen.js: збирає Blob з усіх чанків, URL.createObjectURL(blob),
  повертає лише blobUrl (рядок — безпечно передавати між контекстами)
background.js: chrome.downloads.download({url: blobUrl, filename})
  (саме тут, НЕ в offscreen.js — chrome.downloads там недоступний;
   і НЕ можна навпаки — Blob/createObjectURL недоступні в service worker)
```

Якщо десь на цьому шляху стається помилка — `content.js` шле
`SAVE_FILE_ABORT {sessionId}`, щоб offscreen.js прибрав недозібрані
чанки з Map (інакше вони течуть в пам'яті офскріна, який ніколи не
закривається сам).

### `#EXT-X-MAP` є / немає — fMP4 проти MPEG-TS

`downloadHLS` розпізнає два різні формати VOD HLS:

- є `#EXT-X-MAP:URI="..."` → fragmented MP4: тягне init-сегмент окремо,
  зберігає як `.mp4` (`video/mp4`).
- немає → класичний MPEG-TS: без init-сегмента, просто конкатенація
  `.ts`-сегментів, зберігає як `.ts` (`video/mp2t`).

Форсувати завжди `.mp4` (як у прототипному консольному скрипті, з якого
виросла ця дія) — свідомо НЕ зроблено: файл із сирими TS-байтами під
іменем `.mp4` відкриють толерантні до вмісту плеєри (VLC/ffmpeg), але
строгі (QuickTime, Plex-класифікація за розширенням) — ні.

## Selector picker (`START_ELEMENT_PICKER` → `SELECTOR_PICKED`)

```
popup.js: chrome.tabs.sendMessage(tabId, {type:"START_ELEMENT_PICKER", kind})
content.js: підсвічує елемент під курсором (оверлей), по кліку —
  buildSelectorForElement() (пріоритет: data-* атрибут → #id → tag.class
  → tag), шле chrome.runtime.sendMessage({type:"SELECTOR_PICKED", kind,
  selector}) — НЕ через sendResponse, бо popup гарантовано вже закрився
  (втрата фокусу при кліку по сторінці)
  + показує toast прямо на сторінці (бо popup закрився і не покаже нічого)
background.js: кладе результат у chrome.storage.local["pickerResult"]
popup.js: при відкритті (і через storage.onChanged, якщо раптом ще
  відкритий) — застосовує pickerResult до потрібного поля і видаляє
  запис зі storage ("consume once")
```

`TEST_SELECTOR` — синхронний виклик `ACTIONS.collectLinks()` напряму
(без сесії/пайплайна), лише порахувати кількість і назви — для швидкої
перевірки селектора перед збереженням.

## Схема `chrome.storage.local`

| Ключ                    | Що зберігає |
|-------------------------|-------------|
| `scenarioState`         | `{selectedFile, loadedScenario}` — останній обраний і завантажений сценарій |
| `sessions`              | масив UI-сесій (вкладок) з їх `videos[]` |
| `activeSessionId`       | яка сесія зараз відкрита в popup |
| `sessionPipelineState`  | `{[pipelineSessionId]: {running, paused}}` |
| `sessionProgress`       | `{[pipelineSessionId]: [...HLS_PROGRESS/PIPELINE_STATUS записи, обрізано до 200]}` |
| `selectorHistory`       | масив `{selector, linkSelector, hostname, ts}` |
| `activeSelectorIndex`   | індекс активного запису в `selectorHistory` |
| `selectorFields`        | чернетка полів форми "+ Add" (не джерело правди для Collect links) |
| `pipelineConcurrency`   | останнє введене число паралельних завантажень |
| `pickerResult`          | одноразовий результат picker'а (видаляється одразу після застосування) |

## Як додати дію, що не стосується відео (наприклад, парсинг даних)

1. Проста, одноразова дія (як `getText`/`collectLinks`) — просто нова
   функція в `ACTIONS` у `content.js`, повертає дані синхронно чи
   `Promise`. Виконується через звичайний `RUN_SCENARIO`, результат
   потрапляє в `variables[step.saveAs]`. Додаткової інфраструктури не
   треба.
2. Довготривала дія з прогресом/чергою (як `downloadHLS`) — той самий
   патерн:
   - дія сама шле проміжні `chrome.runtime.sendMessage({type:"MY_PROGRESS",
     pipelineSessionId, ...})`, `background.js` персистить їх у власний
     ключ storage (за аналогією з `sessionProgress`);
   - якщо дії треба зберегти файл чи інший результат, для якого
     потрібен DOM (Blob, Canvas тощо) — через offscreen document, а не
     напряму з `content.js`/`background.js`;
   - оркестрація "для кожного елемента списку — відкрити вкладку,
     виконати, закрити" вже є в `runPipelineAllVideos`/`downloadOneVideo`
     — узагальнення цієї пари функцій (замість вузько "video") — 
     природний наступний крок, коли з'явиться друга така дія.
3. Завжди: жодного `eval`/`new Function`, дані з віддаленого JSON — лише
   параметри для вже написаних функцій, ніколи не код.
