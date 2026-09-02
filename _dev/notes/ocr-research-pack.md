# OCR 一手資料包（curl 自官方 repo/官網，PM-OCR 調研用）

===== DOC: tesseract-readme.md =====
<p align="center">
  <a href="https://tesseract.projectnaptha.com/">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset="./docs/images/tesseract_dark.png">
      <img width="256px" height="256px" alt="Tesseract.js" src="./docs/images/tesseract.png">
    </picture>
  </a>
</p>

![Lint & Test](https://github.com/naptha/tesseract.js/workflows/Node.js%20CI/badge.svg)
![CodeQL](https://github.com/naptha/tesseract.js/workflows/CodeQL/badge.svg)
[![Gitpod Ready-to-Code](https://img.shields.io/badge/Gitpod-ready--to--code-blue?logo=gitpod)](https://github.com/naptha/tesseract.js) 
[![Financial Contributors on Open Collective](https://opencollective.com/tesseractjs/all/badge.svg?label=financial+contributors)](https://opencollective.com/tesseractjs) [![npm version](https://badge.fury.io/js/tesseract.js.svg)](https://badge.fury.io/js/tesseract.js)
[![Maintenance](https://img.shields.io/badge/Maintained%3F-yes-green.svg)](https://github.com/naptha/tesseract.js/graphs/commit-activity)
[![License](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](https://opensource.org/licenses/Apache-2.0)
[![Code Style](https://badgen.net/badge/code%20style/airbnb/ff5a5f?icon=airbnb)](https://github.com/airbnb/javascript)
![npm](https://img.shields.io/npm/dm/tesseract.js?label=npm%20downloads)
![jsDelivr hits (npm)](https://img.shields.io/jsdelivr/npm/hm/tesseract.js?label=jsdelivr%20hits)

Tesseract.js is a javascript library that gets words in [almost any language](./docs/tesseract_lang_list.md) out of images. ([Demo](http://tesseract.projectnaptha.com/))

Image Recognition

[![fancy demo gif](./docs/images/demo.gif)](http://tesseract.projectnaptha.com)

Video Real-time Recognition

<p align="center">
  <a href="https://github.com/jeromewu/tesseract.js-video"><img alt="Tesseract.js Video" src="./docs/images/video-demo.gif"></a>
</p>

Tesseract.js works in the browser using [webpack](https://webpack.js.org/), esm, or plain script tags with a [CDN](#CDN) and on the server with [Node.js](https://nodejs.org/en/).
After you [install it](#installation), using it is as simple as:

```javascript
import { createWorker } from 'tesseract.js';

(async () => {
  const worker = await createWorker('eng');
  const ret = await worker.recognize('https://tesseract.projectnaptha.com/img/eng_bw.png');
  console.log(ret.data.text);
  await worker.terminate();
})();
```
When recognizing multiple images, users should create a worker once, run `worker.recognize` for each image, and then run `worker.terminate()` once at the end (rather than running the above snippet for every image). 

## Installation
Tesseract.js works with a `<script>` tag via local copy or CDN, with webpack via `npm` and on Node.js with `npm/yarn`.

### CDN
```html
<!-- v5 -->
<script src='https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/tesseract.min.js'></script>
```
After including the script the `Tesseract` variable will be globally available and a worker can be created using `Tesseract.createWorker`.

Alternatively, an ESM build (used with `import` syntax) can be found at `https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/tesseract.esm.min.js`. 

### Node.js

**Tesseract.js v7 requires Node.js v16 or newer.** (Tesseract.js v6 requires Node.js v14 or newer.)

```shell
# For latest version
npm install tesseract.js
yarn add tesseract.js

# For old versions
npm install tesseract.js@3.0.3
yarn add tesseract.js@3.0.3
```

## Project Scope
Tesseract.js aims to bring the [Tesseract](https://github.com/tesseract-ocr/tesseract) OCR engine (a separate project) to the browser and Node.js, and works by wrapping a [WebAssembly port](https://github.com/naptha/tesseract.js-core) of Tesseract.  This project does not modify core Tesseract features.  Most notably, **Tesseract.js does not support PDF files and does not modify the Tesseract recognition model to improve accuracy.**

If your project requires features outside of this scope, consider the [Scribe.js library](https://github.com/scribeocr/scribe.js).  Scribe.js is an alternative library created to accommodate common feature requests that are outside of the scope of this repo.  Scribe.js includes improvements to the Tesseract recognition model and supports extracting text from PDF documents, among other features.  For more information see [Scribe.js vs. Tesseract.js](https://github.com/scribeocr/scribe.js/blob/master/docs/scribe_vs_tesseract.md).

## Documentation

* [Workers vs. Schedulers](./docs/workers_vs_schedulers.md)
* [Examples](./docs/examples.md)
* [Supported Image Formats](./docs/image-format.md)
* [API](./docs/api.md)
* [Local Installation](./docs/local-installation.md)
* [FAQ](./docs/faq.md)

## Community Projects and Examples
The following are examples and projects built by the community using Tesseract.js. Officially supported examples are found in the [examples](https://github.com/naptha/tesseract.js/tree/master/examples) directory. 

- Projects
   - Scribe OCR: web application for scanning documents (images and PDFs)
      - Site at [scribeocr.com](https://scribeocr.com/), repo at [github.com/scribeocr/scribeocr](https://github.com/scribeocr/scribeocr)
   - Chrome Extension (with Manifest V3): https://github.com/Tshetrim/Image-To-Text-OCR-extension-for-ChatGPT
- Examples
   - Converting PDF to text: https://github.com/racosa/pdf2text-ocr
   - Use `blocks` output to generate granular data [word/symbol level]: https://github.com/Kishlay-notabot/tesseract-bbox-examples
   - Electron: https://github.com/Balearica/tesseract.js-electron
   - Typescript: https://github.com/Balearica/tesseract.js-typescript
 
If you have a project or example repo that uses Tesseract.js, feel free to add it to this list using a pull request. Examples submitted should be well documented such that new users can run them; projects should be functional and actively maintained.

## Major changes in v6
Version 6 changes are documented in [this issue](https://github.com/naptha/tesseract.js/issues/993).  Highlights are below.
 - Fixed memory leak in previous versions
 - Overall reductions in runtime and memory usage
 - Breaking changes:
    - All outputs formats other than `text` are disabled by default.
      - To re-enable the `hocr` output (for example), set the following: `worker.recognize(image, {}, { hocr: true })`
    - Minor changes to the structure of the JavaScript object (`blocks`) output
    - See [this issue](https://github.com/naptha/tesseract.js/issues/993) for full list

## Major changes in v5
Version 5 changes are documented in [this issue](https://github.com/naptha/tesseract.js/issues/820).  Highlights are below.

 - Significantly smaller files by default (54% smaller for English, 73% smaller for Chinese)
    - This results in a ~50% reduction in runtime for first-time users (who do not have the files cached yet)
 - Significantly lower memory usage
 - Breaking changes:
    - `createWorker` arguments changed
       - Setting non-default language and OEM now happens in `createWorker`
          - E.g. `createWorker("chi_sim", 1)`
    - `worker.initialize` and `worker.loadLanguage` functions should be deleted from code
    - See [this issue](https://github.com/naptha/tesseract.js/issues/820) for full list

Upgrading from v2 to v5?  See [this guide](https://github.com/naptha/tesseract.js/issues/771).

## Major changes in v4
Version 4 includes many new features and bug fixes--see [this issue](https://github.com/naptha/tesseract.js/issues/662) for a full list.  Several highlights are below. 

- Added rotation preprocessing options (including auto-rotate) for significantly better accuracy
- Processed images (rotated, grayscale, binary) can now be retrieved
- Improved support for parallel processing (schedulers)
- Breaking changes:
  - `createWorker` is now async
  - `getPDF` function replaced by `pdf` recognize option

## Contributing

### Development
To run a development copy of Tesseract.js do the following:
```shell
# First we clone the repository
git clone https://github.com/naptha/tesseract.js.git
cd tesseract.js

# Then we install the dependencies
npm install

# And finally we start the development server
npm start
```

The development server will be available at http://localhost:3000/examples/browser/basic-efficient.html in your favorite browser.
It will automatically rebuild `tesseract.min.js` and `worker.min.js` when you change files in the **src** folder.

### Building Static Files
To build the compiled static files just execute the following:
```shell
npm run build
```
This will output the files into the `dist` directory.

### Run Tests
**Always confirm the automated tests pass before submitting a pull request.**  To run the automated tests locally, run the following commands.
```shell
npm run lint
npm run test
```

## Contributors

### Code Contributors

This project exists thanks to all the people who contribute. [[Contribute](https://github.com/naptha/tesseract.js?tab=readme-ov-file#contributing)].
<a href="https://github.com/naptha/tesseract.js/graphs/contributors"><img src="https://opencollective.com/tesseractjs/contributors.svg?width=890&button=false" /></a>

### Financial Contributors

Become a financial contributor and help us sustain our community. [[Contribute](https://opencollective.com/tesseractjs/contribute)]

#### Individuals

<a href="https://opencollective.com/tesseractjs"><img src="https://opencollective.com/tesseractjs/individuals.svg?width=890"></a>

#### Organizations

Support this project with your organization. Your logo will show up here with a link to your website. [[Contribute](https://opencollective.com/tesseractjs/contribute)]

<a href="https://opencollective.com/tesseractjs/organization/0/website"><img src="https://opencollective.com/tesseractjs/organization/0/avatar.svg"></a>
<a href="https://opencollective.com/tesseractjs/organization/1/website"><img src="https://opencollective.com/tesseractjs/organization/1/avatar.svg"></a>
<a href="https://opencollective.com/tesseractjs/organization/2/website"><img src="https://opencollective.com/tesseractjs/organization/2/avatar.svg"></a>
<a href="https://opencollective.com/tesseractjs/organization/3/website"><img src="https://opencollective.com/tesseractjs/organization/3/avatar.svg"></a>
<a href="https://opencollective.com/tesseractjs/organization/4/website"><img src="https://opencollective.com/tesseractjs/organization/4/avatar.svg"></a>
<a href="https://opencollective.com/tesseractjs/organization/5/website"><img src="https://opencollective.com/tesseractjs/organization/5/avatar.svg"></a>
<a href="https://opencollective.com/tesseractjs/organization/6/website"><img src="https://opencollective.com/tesseractjs/organization/6/avatar.svg"></a>
<a href="https://opencollective.com/tesseractjs/organization/7/website"><img src="https://opencollective.com/tesseractjs/organization/7/avatar.svg"></a>
<a href="https://opencollective.com/tesseractjs/organization/8/website"><img src="https://opencollective.com/tesseractjs/organization/8/avatar.svg"></a>
<a href="https://opencollective.com/tesseractjs/organization/9/website"><img src="https://opencollective.com/tesseractjs/organization/9/avatar.svg"></a>

===== DOC: tesseract-api.md =====
# API

- [createWorker()](#create-worker)
  - [Worker.recognize](#worker-recognize)
  - [Worker.setParameters](#worker-set-parameters)
  - [Worker.reinitialize](#worker-reinitialize)
  - [Worker.detect](#worker-detect)
  - [Worker.terminate](#worker-terminate)
  - [Worker.writeText](#worker-writeText)
  - [Worker.readText](#worker-readText)
  - [Worker.removeFile](#worker-removeFile)
  - [Worker.FS](#worker-FS)
- [createScheduler()](#create-scheduler)
  - [Scheduler.addWorker](#scheduler-add-worker)
  - [Scheduler.addJob](#scheduler-add-job)
  - [Scheduler.getQueueLen](#scheduler-get-queue-len)
  - [Scheduler.getNumWorkers](#scheduler-get-num-workers)
- [setLogging()](#set-logging)
- [recognize()](#recognize)
- [detect()](#detect)
- [PSM](#psm)
- [OEM](#oem)

---

<a name="create-worker"></a>
## createWorker(options): Worker

`createWorker` is a function that creates a Tesseract.js worker.  A Tesseract.js worker is an object that creates and manages an instance of Tesseract running in a web worker (browser) or worker thread (Node.js).  Once created, OCR jobs are sent through the worker. 


**Arguments:**

- `langs` a string to indicate the languages traineddata to download, multiple languages are specified using an array (['eng', 'chi_sim'])
- `oem` a enum to indicate the OCR Engine Mode you use
- `options` an object of customized options
  - `corePath` path to a directory containing **all of** the following files from [Tesseract.js-core](https://www.npmjs.com/package/tesseract.js-core) package:
     - `tesseract-core.wasm.js`
     - `tesseract-core-simd.wasm.js`
     - `tesseract-core-lstm.wasm.js`
     - `tesseract-core-simd-lstm.wasm.js`
     - Some code snippets found online set `corePath` to a specific `.js` file. This is **strongly discouraged.**  To provide the best performance and lowest network usage, Tesseract.js needs to be able to pick between builds.
  - `langPath` path for downloading traineddata, do not include `/` at the end of the path
  - `workerPath` path for downloading worker script
  - `dataPath` path for saving traineddata in WebAssembly file system, not common to modify
  - `cachePath` path for the cached traineddata, more useful for Node, for browser it only changes the key in IndexDB
  - `cacheMethod` a string to indicate the method of cache management, should be one of the following options
    - write: read cache and write back (default method)
    - readOnly: read cache and not to write back
    - refresh: not to read cache and write back
    - none: not to read cache and not to write back
  - `legacyCore` set to `true` to ensure any code downloaded supports the Legacy model (in addition to LSTM model)
  - `legacyLang` set to `true` to ensure any language data downloaded supports the Legacy model (in addition to LSTM model)
  - `workerBlobURL` a boolean to define whether to use Blob URL for worker script, default: true
  - `gzip` a boolean to define whether the traineddata from the remote is gzipped, default: true
  - `logger` a function to log the progress, a quick example is `m => console.log(m)`
  - `errorHandler` a function to handle worker errors, a quick example is `err => console.error(err)`
- `config` an object of customized options which are set prior to initialization
  - This argument allows for setting "init only" Tesseract parameters
	  - Most Tesseract parameters can be set after a worker is initialized, using either `worker.setParameters` or the `options` argument of `worker.recognize`.  
	  - A handful of Tesseract parameters, referred to as "init only" parameters in Tesseract documentation, cannot be modified after Tesseract is initialized--these can only be set using this argument
		  - Examples include `load_system_dawg`, `load_number_dawg`, and `load_punc_dawg`

**Examples:**

```javascript
const { createWorker } = Tesseract;
const worker = await createWorker('eng', 1, {
  langPath: '...',
  logger: m => console.log(m),
});
```

<a name="worker-recognize"></a>
### worker.recognize(image, options, output, jobId): Promise

`worker.recognize` provides core function of Tesseract.js as it executes OCR

Figures out what words are in `image`, where the words are in `image`, etc.
> [!TIP]
> Note: `image` should be sufficiently high resolution.
> Often, the same image will get much better results if you upscale it before calling `recognize`.

**Arguments:**

- `image` see [Image Format](./image-format.md) for more details.
- `options` an object of customized options
  - `rectangle` an object to specify the regions you want to recognized in the image, should contain top, left, width and height, see example below.
- `output` an object specifying which output formats to return (by default only `text` is returned)
   - Other options include `blocks` (json), `hocr`, and `tsv`
- `jobId` Please see details above

**Output:**
`worker.recognize` returns a promise to an object containing `jobId` and `data` properties.  The `data` property contains output in all of the formats specified using the `output` argument.

> [!NOTE]  
> `worker.recognize` still returns an output object even if no text is detected (the outputs will simply contain no words). No exception is thrown as determining the page is empty is considered a valid result. 

**Examples:**

```javascript
const { createWorker } = Tesseract;
(async () => {
  const worker = await createWorker('eng');
  const { data: { text } } = await worker.recognize(image);
  console.log(text);
})();
```

With rectangle

```javascript
const { createWorker } = Tesseract;
(async () => {
  const worker = await createWorker('eng');
  const { data: { text } } = await worker.recognize(image, {
    rectangle: { top: 0, left: 0, width: 100, height: 100 },
  });
  console.log(text);
})();
```

<a name="worker-set-parameters"></a>
### worker.setParameters(params, jobId): Promise

`worker.setParameters()` set parameters for Tesseract API (using SetVariable()), it changes the behavior of Tesseract and some parameters like tessedit\_char\_whitelist is very useful.

**Arguments:**

- `params` an object with key and value of the parameters
- `jobId` Please see details above

Note:  `worker.setParameters` cannot be used to change the `oem`, as this value is set at initialization.  `oem` is initially set using an argument of `createWorker`.  After a worker already exists, changing `oem` requires running `worker.reinitialize`.

**Useful Parameters:**

| name                        | type   | default value     | description                                                                                                                     |
| --------------------------- | ------ | ----------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| tessedit\_pageseg\_mode     | enum   | PSM.SINGLE\_BLOCK | Check [HERE](https://github.com/tesseract-ocr/tesseract/blob/4.0.0/src/ccstruct/publictypes.h#L163) for definition of each mode |
| tessedit\_char\_whitelist   | string | ''                | setting white list characters makes the result only contains these characters, useful if content in image is limited           |
| preserve\_interword\_spaces | string | '0'               | '0' or '1', keeps the space between words                                                                                       |
| user\_defined\_dpi          | string | ''                | Define custom dpi, use to fix **Warning: Invalid resolution 0 dpi. Using 70 instead.**                                          |

This list is incomplete.  As Tesseract.js passes parameters to the Tesseract engine, all parameters supported by the underlying version of Tesseract should also be supported by Tesseract.js.  (Note that parameters marked as “init only” in Tesseract documentation cannot be set by `setParameters` or `recognize`.) 

**Examples:**

```javascript
(async () => {
  await worker.setParameters({
    tessedit_char_whitelist: '0123456789',
  });
})
```

<a name="worker-reinitialize"></a>
### worker.reinitialize(langs, oem, jobId): Promise

`worker.reinitialize()` re-initializes an existing Tesseract.js worker with different `langs` and `oem` arguments.  

**Arguments:**

- `langs` a string to indicate the languages traineddata to download, multiple languages are specified using an array (['eng', 'chi_sim'])
- `oem` a enum to indicate the OCR Engine Mode you use
- `config` an object of customized options which are set prior to initialization (see details above)
- `jobId` Please see details above

Note: to switch from Tesseract LSTM (`oem` value `1`) to Tesseract Legacy (`oem` value `0`) using `worker.reinitialize()`, the worker must already contain the code required to run the Tesseract Legacy model.  Setting `legacyCore: true` and `legacyLang: true` in `createWorker` options ensures this is the case.

**Examples:**

```javascript
await worker.reinitialize('eng', 1);
```

<a name="worker-detect"></a>
### worker.detect(image, jobId): Promise

`worker.detect` does OSD (Orientation and Script Detection) to the image instead of OCR.

> [!NOTE]  
> Running `worker.detect` requires a worker with code and language data that supports Tesseract Legacy (this is not enabled by default).  If you want to run `worker.detect`, set `legacyCore` and `legacyLang` to `true` in the `createWorker` options. 

**Arguments:**

- `image` see [Image Format](./image-format.md) for more details.
- `jobId` Please see details above

**Examples:**

```javascript
const { createWorker } = Tesseract;
(async () => {
  const worker = await createWorker('eng', 1, {legacyCore: true, legacyLang: true});
  const { data } = await worker.detect(image);
  console.log(data);
})();
```

<a name="worker-terminate"></a>
### worker.terminate(jobId): Promise

`worker.terminate` terminates the worker and cleans up

```javascript
(async () => {
  await worker.terminate();
})();
```


<a name="worker-writeText"></a>
### Worker.writeText(path, text, jobId): Promise

`worker.writeText` writes a text file to the path specified in MEMFS, it is useful when you want to use some features that requires tesseract.js
to read file from file system.

**Arguments:**

- `path` text file path
- `text` content of the text file
- `jobId` Please see details above

**Examples:**

```javascript
(async () => {
  await worker.writeText('tmp.txt', 'Hi\nTesseract.js\n');
})();
```

<a name="worker-readText"></a>
### worker.readText(path, jobId): Promise

`worker.readText` reads a text file to the path specified in MEMFS, it is useful when you want to check the content.

**Arguments:**

- `path` text file path
- `jobId` Please see details above

**Examples:**

```javascript
(async () => {
  const { data } = await worker.readText('tmp.txt');
  console.log(data);
})();
```

<a name="worker-removeFile"></a>
### worker.removeFile(path, jobId): Promise

`worker.removeFile` removes a file in MEMFS, it is useful when you want to free the memory.

**Arguments:**

- `path` file path
- `jobId` Please see details above

**Examples:**

```javascript
(async () => {
  await worker.removeFile('tmp.txt');
})();
```

<a name="worker-FS"></a>
### worker.FS(method, args, jobId): Promise

`worker.FS` is a generic FS function to do anything you want, you can check [HERE](https://emscripten.org/docs/api_reference/Filesystem-API.html) for all functions.

**Arguments:**

- `method` method name
- `args` array of arguments to pass  
- `jobId` Please see details above

**Examples:**

```javascript
(async () => {
  await worker.FS('writeFile', ['tmp.txt', 'Hi\nTesseract.js\n']);
  // equal to:
  // await worker.writeText('tmp.txt', 'Hi\nTesseract.js\n');
})();
```

<a name="create-scheduler"></a>
## createScheduler(): Scheduler

`createScheduler` is a factory function to create a scheduler, a scheduler manages a job queue and workers to enable multiple workers to work together, it is useful when you want to speed up your performance.

**Examples:**

```javascript
const { createScheduler } = Tesseract;
const scheduler = createScheduler();
```

### Scheduler

<a name="scheduler-add-worker"></a>
### scheduler.addWorker(worker): string

`scheduler.addWorker` adds a worker into the worker pool inside scheduler, it is suggested to add one worker to only one scheduler.

**Arguments:**

- `worker` see Worker above

**Examples:**

```javascript
const { createWorker, createScheduler } = Tesseract;
const scheduler = createScheduler();
const worker = await createWorker();
scheduler.addWorker(worker);
```

<a name="scheduler-add-job"></a>
### scheduler.addJob(action, ...payload): Promise

`scheduler.addJob` adds a job to the job queue and scheduler waits and finds an idle worker to take the job.

**Arguments:**

- `action` a string to indicate the action you want to do, right now only **recognize** and **detect** are supported
- `payload` a arbitrary number of args depending on the action you called.

**Examples:**

```javascript
(async () => {
 const { data: { text } } = await scheduler.addJob('recognize', image, options);
 const { data } = await scheduler.addJob('detect', image);
})();
```

<a name="scheduler-get-queue-len"></a>
### scheduler.getQueueLen(): number

`scheduler.getQueueLen()` returns the length of job queue.

<a name="scheduler-get-num-workers"></a>
### Scheduler.getNumWorkers(): number

`Scheduler.getNumWorkers()` returns number of workers added into the scheduler

<a name="scheduler-terminate"></a>
### scheduler.terminate(): Promise

`scheduler.terminate()` terminates all workers added, useful to do quick clean up.

**Examples:**

```javascript
(async () => {
  await scheduler.terminate();
})();
```

<a name="set-logging"></a>
## setLogging(logging: boolean)

`setLogging` sets the logging flag, you can `setLogging(true)` to see detailed information, useful for debugging.

**Arguments:**

- `logging` boolean to define whether to see detailed logs, default: false

**Examples:**

```javascript
const { setLogging } 
===== DOC: mlkit-v2.txt =====
 Text recognition v2 | ML Kit | Google for Developers Skip to main content ML Kit Guides Reference Samples Case studies Community / English Deutsch Español Español – América Latina Français Indonesia Italiano Polski Português – Brasil Tiếng Việt Türkçe Русский עברית العربيّة فارسی हिंदी বাংলা ภาษาไทย 中文 – 简体 中文 – 繁體 日本語 한국어 Sign in Guides ML Kit Guides Reference Samples Case studies Community Overview Release notes Known issues Early access program Migrating from ML Kit for Firebase Overview Android iOS Migrating from Mobile Vision Overview Android iOS GenAI Overview Summarization (Beta) Proofreading (Beta) Rewriting (Beta) Image description (Beta) Speech recognition (Alpha) Prompt (Beta) Overview Get started Prompt design Evaluate prompt quality Set system instructions (Beta) Prefix caching (Experimental) Generate structured output (Alpha) Use thinking mode (Beta) Select a model AICore Developer Preview program Vision Text recognition v2 Overview Supported languages Android iOS Face detection Overview Face detection concepts Android iOS Face mesh detection (Beta) Overview Face mesh detection concepts Android Pose detection (Beta) Overview Android iOS Pose Classification Options Selfie segmentation (Beta) Overview Android iOS Subject segmentation (Beta) Overview Android Document scanner Overview Android Barcode scanning Overview Android iOS Google code scanner (Android only) Image labeling Overview Base model Label map Android iOS Custom models Android iOS AutoML Vision Edge Migrate to custom models Android iOS Object detection and tracking Overview Base models Android iOS Custom models Android iOS Digital ink recognition Overview Base models Android iOS Custom models Natural language Language identification Overview Supported languages Android iOS Translation Overview Guidelines Supported languages Android iOS Smart reply Overview Android iOS Entity extraction (Beta) Overview Android iOS Tips Model installation paths on Android Reduce Android app package size Colophon Terms & Privacy Overview GenAI API Terms Android Data Disclosure iOS Data Disclosure Home Products ML Kit Guides Send feedback Text recognition v2 Stay organized with collections Save and categorize content based on your preferences. Page Summary outlined_flag The ML Kit Text Recognition v2 API recognizes text in Chinese, Devanagari, Japanese, Korean, and Latin scripts and can automate data entry for documents like credit cards and receipts. It analyzes text structure by identifying blocks, lines, elements (words), and symbols, returning bounding boxes, corner points, and confidence scores for each. The API supports real-time text recognition on various devices and can identify the language of the recognized text. The ML Kit Text Recognition v2 API can recognize text in any Chinese, Devanagari, Japanese, Korean and Latin character set. The API can also be used to automate data-entry tasks such as processing credit cards, receipts, and business cards. iOS Android Key capabilities Recognize text across various scripts and languages Supports recognizing text in Chinese, Devanagari, Japanese, Korean and Latin scripts Analyzes structure of text Supports detection of symbols, elements, lines and paragraphs Identify language of text Identifies the language of the recognized text Real-time recognition Can recognize text in real-time on a wide range of devices Text structure The Text Recognizer segments text into blocks, lines, elements and symbols. Roughly speaking: a Block is a contiguous set of text lines, such as a paragraph or column, a Line is a contiguous set of words on the same axis, and an Element is a contiguous set of alphanumeric characters ("word") on the same axis in most Latin languages, or a word in others an Symbol is a single alphanumeric character on the same axis in most Latin languages, or a character in others The image below highlights examples of each of these in descending order. The first highlighted block, in cyan, is a Block of text. The second set of highlighted blocks, in blue, are Lines of text. Finally, the third set of highlighted blocks, in dark blue, are Words. For all detected blocks, lines, elements and symbols, the API returns the bounding boxes, corner points, rotation information, confidence score, recognized languages and recognized text. Example results Photo: Dietmar Rabich , Wikimedia Commons , "Düsseldorf, Wege der parlamentarischen Demokratie -- 2015 -- 8123" , CC BY-SA 4.0 Recognized Text Text Wege der parlamentarischen Demokratie Blocks (1 block) Block 0 Text Wege der parlamentarischen Demokratie Frame (296, 665 - 796, 882) Corner Points (296, 719), (778, 665), (796, 828), (314, 882) Recognized Language Code de Lines (3 lines) Line 0 Text Wege der Frame (434, 678 - 670, 749) Corner Points (434, 705), (665, 678), (670, 722), (439, 749) Recognized Language Code de Confidence Score 0.8766741 Rotation Degree -6.6116457 Elements (2 elements) Element 0 Text Wege Frame (434, 689 - 575, 749) Corner Points (434, 705), (570, 689), (575, 733), (439, 749) Recognized Language Code de Confidence Score 0.8964844 Rotation Degree -6.6116457 Elements (4 elements) Symbol 0 Text W Frame (434, 698 - 500, 749) Corner Points (434, 706), (495, 698), (500, 741), (439, 749) Confidence Score 0.87109375 Rotation Degree -6.611646 Send feedback Except as otherwise noted, the content of this page is licensed under the Creative Commons Attribution 4.0 License , and code samples are licensed under the Apache 2.0 License . For details, see the Google Developers Site Policies . Java is a registered trademark of Oracle and/or its affiliates. Last updated 2024-07-10 UTC. Need to tell us more? [[["Easy to understand","easyToUnderstand","thumb-up"],["Solved my problem","solvedMyProblem","thumb-up"],["Other","otherUp","thumb-up"]],[["Missing the information I need","missingTheInformationINeed","thumb-down"],["Too complicated / too many steps","tooComplicatedTooManySteps","thumb-down"],["Out of date","outOfDate","thumb-down"],["Samples / code issue","samplesCodeIssue","thumb-down"],["Other","otherDown","thumb-down"]],["Last updated 2024-07-10 UTC."],[],["The ML Kit Text Recognition v2 API recognizes text in Chinese, Devanagari, Japanese, Korean, and Latin scripts. It analyzes text structure by detecting blocks, lines, elements, and symbols, and identifies the language. The API provides bounding boxes, corner points, rotation, confidence scores, recognized languages, and text for detected text. This API can be used for automating data entry from credit cards, receipts and business cards. It also support real time text recognition.\n"]] Engage Google Developer Program Google Developer Groups Google Developer Experts Accelerators Google Cloud & NVIDIA Connect Blog Bluesky Instagram LinkedIn X (Twitter) YouTube Build Android Chrome Firebase Google AI Studio Google Antigravity Google Cloud Google Play View all Android Chrome Firebase Google Cloud Platform Google AI All products Terms Privacy Manage cookies English Deutsch Español Español – América Latina Français Indonesia Italiano Polski Português – Brasil Tiếng Việt Türkçe Русский עברית العربيّة فارسی हिंदी বাংলা ภาษาไทย 中文 – 简体 中文 – 繁體 日本語 한국어 
===== DOC: paddleocr.md =====

<div align="center">
  <p>
      <img width="800" src="https://raw.githubusercontent.com/cuicheng01/PaddleX_doc_images/main/images/paddleocr/README/Banner.png" alt="Star-history">
  </p>



<h3>Global Leading OCR Toolkit & Document AI Engine</h3>

English | [简体中文](./readme/README_cn.md) | [繁體中文](./readme/README_tcn.md) | [日本語](./readme/README_ja.md) | [한국어](./readme/README_ko.md) | [Français](./readme/README_fr.md) | [Русский](./readme/README_ru.md) | [Español](./readme/README_es.md) | [العربية](./readme/README_ar.md)

<!-- icon -->

[![PyPI Downloads](https://static.pepy.tech/badge/paddleocr)](https://pepy.tech/projects/paddleocr)
[![Used by](https://img.shields.io/badge/Used%20by-6k%2B%20repositories-blue)](https://github.com/PaddlePaddle/PaddleOCR/network/dependents)
![python](https://img.shields.io/badge/python-3.8~3.12-aff.svg)
![os](https://img.shields.io/badge/os-linux%2C%20win%2C%20mac-pink.svg)
![hardware](https://img.shields.io/badge/hardware-cpu%2C%20gpu%2C%20xpu%2C%20npu-yellow.svg)

[![AI Studio](https://img.shields.io/badge/PaddleOCR-_Offiical_Website-1927BA?logo=data:image/png;base64,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&labelColor=white)](https://www.paddleocr.com)
[![Ask DeepWiki](https://deepwiki.com/badge.svg)](https://deepwiki.com/PaddlePaddle/PaddleOCR)
[![License](https://img.shields.io/badge/license-Apache_2.0-green)](../LICENSE)

</div>






**PaddleOCR converts PDF documents and images into structured, LLM-ready data (JSON/Markdown) with industry-leading accuracy. With 70k+ Stars and trusted by top-tier projects like Dify, RAGFlow, and Cherry Studio, PaddleOCR is the bedrock for building intelligent RAG and Agentic applications.**


## 🚀 Key Features

### 📄 Intelligent Document Parsing (LLM-Ready)
> *Transforming messy visuals into structured data for the LLM era.*

* **SOTA Document VLM**: Featuring **PaddleOCR-VL-1.6 (0.9B)**, the industry's leading lightweight vision-language model for document parsing. It achieves 96.3% accuracy on OmniDocBench v1.6, leads in text, formula, and table recognition, and shows significantly enhanced capabilities in ancient documents, rare characters, seals, and charts, with structured outputs in **Markdown** and **JSON** formats.
* **Structure-Aware Conversion**: Powered by **PP-StructureV3**, seamlessly convert complex PDFs and images into **Markdown** or **JSON**. Unlike the PaddleOCR-VL series models, it provides more fine-grained coordinate information, including table cell coordinates, text coordinates, and more.
* **Production-Ready Efficiency**: Achieve commercial-grade accuracy with an ultra-small footprint. Outperforms numerous closed-source solutions in public benchmarks while remaining resource-efficient for edge/cloud deployment.

### 🔍 Universal Text Recognition (Scene OCR)
> *The global gold standard for high-speed, multilingual text spotting.*

* **100+ Languages Supported**: Native recognition for a vast global library. **PP-OCRv6** supports 50 languages with a single unified model (Chinese, English, Japanese, and 46 Latin-script languages) — no model switching needed for multilingual documents.
* **Complex Element Mastery**: Beyond standard text recognition, we support **natural scene text spotting** across a wide range of environments, including IDs, street views, books, and industrial components
* **Performance Leap**: PP-OCRv6 achieves **+4.6% detection** and **+5.1% recognition** accuracy over PP-OCRv5, surpassing mainstream Vision-Language Models. 5.2× CPU inference speedup end-to-end.

<div align="center">
  <p>
      <img width="100%" src="https://raw.githubusercontent.com/cuicheng01/PaddleX_doc_images/main/images/paddleocr/README/Arch.jpg" alt="PaddleOCR Architecture">
  </p>
</div>

### 🛠️ Developer-Centric Ecosystem
* **Seamless Integration**: The premier choice for the AI Agent ecosystem—deeply integrated with **Dify, RAGFlow, Pathway, and Cherry Studio**.
* **LLM Data Flywheel**: A complete pipeline to build high-quality datasets, providing a sustainable "Data Engine" for fine-tuning Large Language Models.
* **One-Click Deployment**: Supports various hardware backends (NVIDIA GPU, Intel CPU, Kunlunxin XPU, and diverse AI Accelerators).


## 📣 Recent updates

### 🔥 2026.07.22: HPD-Parsing is now available
- **HPD-Parsing** is a lightweight vision-language model designed for high-throughput document parsing. It adopts a hierarchical parallel decoding paradigm and Progressive Multi-Token Prediction (P-MTP), achieving a peak throughput of 4,752 tokens/s on public benchmarks while maintaining competitive parsing accuracy.
- HPD-Parsing supports both OpenAI-compatible serving and local inference through a customized vLLM runtime, making it suitable for document parsing scenarios with high demands on inference efficiency and deployment throughput.
- See the [HPD-Parsing usage tutorial](https://www.paddleocr.ai/latest/en/version3.x/pipeline_usage/HPD-Parsing.html) for environment setup, serving, and local inference instructions.

<details>
<summary><strong>2026.06.11: Release of PaddleOCR 3.7.0</strong></summary>

- PP-OCRv6 highlights:

    - **Accuracy boost**: Medium tier achieves +4.6% detection and +5.1% recognition over PP-OCRv5_server, surpassing mainstream VLMs (Qwen3-VL-235B, GPT-5.5) with only 34.5M parameters.
    - **50 languages unified**: Single model covers Chinese, English, Japanese, and 46 Latin-script languages — no model switching needed.
    - **Specialized scenarios**: Major improvements in digital displays, dot-matrix characters, tire prints, and industrial text recognition.
    - **Faster inference**: 5.2× CPU speedup (OpenVINO), 6.1× on Apple M4 (tiny), 0.13s on A100 GPU.
    - **Three tiers for all scenarios**: tiny (1.5M) / small (7.7M) / medium (34.5M) for edge, mobile, and server deployment.
    - **Model availability**: All models are available on [HuggingFace](https://huggingface.co/collections/PaddlePaddle/pp-ocrv6) and [ModelScope](https://www.modelscope.cn/collections/PaddlePaddle/PP-OCRv6).

</details>

<details>
<summary><strong>2026.05.28: Release of PaddleOCR 3.6.0</strong></summary>

- PaddleOCR-VL-1.6 highlights:

    - **New SOTA Accuracy**: Achieves over 96.3% on OmniDocBench v1.6, also sets new SOTA on OmniDocBench v1.5 and Real5-OmniDocBench, leading both open-source and proprietary solutions in text, formula, and table recognition.
    - **Comprehensive Capability Upgrade**: Significant improvements in table, ancient document, and rare character recognition, with notably enhanced seal recognition, spotting, and chart understanding across multiple scenarios.
    - **Seamless Migration**: Model architecture is fully consistent with PaddleOCR-VL-1.5, enabling zero-cost adaptation—swap and go.
    - **Try it now**: Available on [HuggingFace](https://huggingface.co/PaddlePaddle/PaddleOCR-VL-1.6) or our [Official Website](https://www.paddleocr.com).

</details>

<details>
<summary><strong>2026.04.21: Release of PaddleOCR 3.5.0</strong></summary>

* **Flexible inference backends**: Seamlessly switch between Paddle static graph, Paddle dynamic graph, or Transformers. PaddleOCR is now deeply integrated with the Hugging Face ecosystem, and 20 major models support Transformers as the inference backend.
* **Office documents to Markdown**: Convert common document formats such as Word, Excel, and PowerPoint into Markdown.
* **DOCX export for parsed results**: The `PaddleOCR-VL` series, `PP-StructureV3`, and `PP-DocTranslation` now support exporting parsed results to DOCX for convenient viewing and editing in Microsoft Word.
* **Official browser inference SDK**: Released `PaddleOCR.js`, the official browser inference SDK that supports running `PP-OCRv5` directly in the browser.

</details>

<details>
<summary><strong>2026.01.29: Release of PaddleOCR 3.4.0</strong></summary>

* PaddleOCR-VL-1.5 (SOTA 0.9B VLM): Our latest flagship model for document parsing is now live!
    * **94.5% Accuracy on OmniDocBench**: Surpassing top-tier general large models and specialized document parsers.
    * **Real-World Robustness**: First to introduce the **PP-DocLayoutV3** algorithm for irregular shape positioning, mastering 5 tough scenarios: *Skew, Warping, Scanning, Illumination, and Screen Photography*.
    * **Capability Expansion**: Now supports **Seal Recognition**, **Text Spotting**, and expands to **111 languages** (including China’s Tibetan script and Bengali).
    * **Long Document Mastery**: Supports automatic cross-page table merging and hierarchical heading identification.
    * **Try it now**: Available on [HuggingFace](https://huggingface.co/PaddlePaddle/PaddleOCR-VL-1.5) or our [Official Website](https://www.paddleocr.com).

</details>

<details>
<summary><strong>2025.10.16: Release of PaddleOCR 3.3.0</strong></summary>

- Released PaddleOCR-VL:
    - **Model Introduction**:
        - **PaddleOCR-VL** is a SOTA and resource-efficient model tailored for document parsing. Its core component is PaddleOCR-VL-0.9B, a compact yet powerful vision-language model (VLM) that integrates a NaViT-style dynamic resolution visual encoder with the ERNIE-4.5-0.3B language model to enable accurate element recognition. **This innovative model efficiently supports 109 languages and excels in recognizing complex elements (e.g., text, tables, formulas, and charts), while maintaining minimal resource consumption**. Through comprehensive evaluati
===== DOC: ankidroid.md =====
<p align="center">
<img alt="" src="docs/graphics/logos/banner_readme.png"/>
</p>

<a href="https://github.com/ankidroid/Anki-Android/releases"><img src="https://img.shields.io/github/v/release/ankidroid/Anki-Android" alt="release"/></a>
<a href="https://github.com/ankidroid/Anki-Android/actions"><img src="https://img.shields.io/github/checks-status/ankidroid/Anki-Android/main?label=build" alt="build"/></a>
<a href="https://opencollective.com/ankidroid"><img src="https://img.shields.io/opencollective/all/ankidroid" alt="Open Collective backers and sponsors"/></a>
<a href="https://github.com/ankidroid/Anki-Android/issues"><img src="https://img.shields.io/github/commit-activity/m/ankidroid/Anki-Android" alt="commit-activity"/></a>
<a href="https://github.com/ankidroid/Anki-Android/network/members"><img src="https://img.shields.io/github/forks/ankidroid/Anki-Android" alt="forks"/></a>
<a href="https://github.com/ankidroid/Anki-Android/stargazers"><img src="https://img.shields.io/github/stars/ankidroid/Anki-Android" alt="stars"/></a>
<a href="https://crowdin.com/project/ankidroid"><img src="https://badges.crowdin.net/ankidroid/localized.svg"></img></a>
<a href="https://github.com/ankidroid/Anki-Android/graphs/contributors"><img src="https://img.shields.io/github/contributors/ankidroid/Anki-Android" alt="contributors"/></a>
<a href="https://discord.gg/qjzcRTx"><img src="https://img.shields.io/discord/368267295601983490"></img></a>
<a href="https://github.com/ankidroid/Anki-Android/blob/main/COPYING"><img src="https://img.shields.io/github/license/ankidroid/Anki-Android" alt="license"/></a>

# AnkiDroid
A semi-official port of the open source [Anki](https://apps.ankiweb.net/index.html) spaced repetition flashcard system to Android. Memorize anything with AnkiDroid!

<img src="docs/graphics/logos/ankidroid_logo.png" align="right" width="40%" height="100%"></img>

### Features

<div style="display:flex;">
 
- Night mode
- Whiteboard 
- Progress widget
- Detailed statistics
- Syncing with AnkiWeb
- Write answers (optional)
- Text-to-speech integration
- More than 10,000 premade decks
- Spaced repetition (AI-optimized [FSRS algorithm](https://github.com/open-spaced-repetition))
- Supported contents: text, images, sounds, MathJax
- Add cards by intent from other applications like dictionaries

</div>

Install
---------
<div style="display:flex;">

<a href="https://play.google.com/store/apps/details?id=com.ichi2.anki&utm_source=global_co&utm_medium=prtnr&utm_content=Mar2515&utm_campaign=PartBadge&pcampaignid=MKT-Other-global-all-co-prtnr-py-PartBadge-Mar2515-1">
    <img alt="Get it on Google Play" height="80"
        src="docs/graphics/logos/google-badge.png" /></a>

<a href="https://f-droid.org/repository/browse/?fdid=com.ichi2.anki">
    <img alt="Get it on F-Droid" height="80"
        src="docs/graphics/logos/f-droid-badge.png"></a>

<a href="http://apps.obtainium.imranr.dev/redirect.html?r=obtainium://add/https://github.com/ankidroid/Anki-Android">
    <img alt="Get it on Obtainium" height="80"
        src="https://github.com/user-attachments/assets/713d71c5-3dec-4ec4-a3f2-8d28d025a9c6"/></a>

</div>

Signing certificate fingerprint to [verify](https://developer.android.com/studio/command-line/apksigner#usage-verify) the APK:
```
SHA-256: 2071534f0f4b5e54ae952dd275d70da6e3459ee69909d2ab1b4843c4c5b21a45 
SHA-1: f24e06a3657b190a12671100402df32d7b9b3d36
```

Wiki
----
View [Wiki](https://github.com/ankidroid/Anki-Android/wiki)

Help
----
Check the [user manual](https://docs.ankidroid.org/) and the wiki for usage instructions. See the [help page](https://docs.ankidroid.org/help.html) 
for how to submit a bug report or contact a project member, etc.

Contribute
----------
You can contribute to AnkiDroid by beta testing, translating, or submitting code. 
See the [contribution wiki page](https://github.com/ankidroid/Anki-Android/wiki/Contributing) for more info.

Join Us On
----------

<a href="https://discord.gg/qjzcRTx"><img src="docs/graphics/logos/discord_logo_color.svg" height="46px"/></a>
<a href="https://www.reddit.com/r/Anki"><img src="docs/graphics/logos/reddit_logo_color.png" height="50px"/></a>
<a href="https://www.facebook.com/AnkiDroid/"><img src="docs/graphics/logos/facebook_logo_color.png" height="50px"/></a>
<a href="https://x.com/ankidroid"><img src="docs/graphics/logos/twitter_logo.png" height="50px"/></a>
<a href="https://forums.ankiweb.net/"><img src="/docs/graphics/logos/anki_forums_logo.png" height="50px"/></a>

## Credits
<!--- Do not rename this section. AnkiDroid contains a deep link to the section
header - see https://github.com/ankidroid/Anki-Android/pull/11803 --->

### Code Contributors

Thanks to these awesome code contributors who keep this project going

<a href="https://github.com/ankidroid/Anki-Android/graphs/contributors"><img src="https://opencollective.com/ankidroid/contributors.svg?width=890&button=false" /></a>

### [Sponsors](https://opencollective.com/ankidroid#sponsor)
<a href="https://opencollective.com/ankidroid#sponsor" target="_blank">
  <img alt="AnkiDroid Sponsors" src="https://opencollective.com/Ankidroid/sponsors.svg?width=890" />
</a>

### [Backers](https://opencollective.com/ankidroid#backer)

A big thank you to each of our backers 🙏
<a href="https://opencollective.com/Ankidroid#backers" target="_blank"><img width=110 src="https://opencollective.com/Ankidroid/backers/badge.svg?"></a>

<p>Your generous donations mean the world to us, and we can't express our gratitude enough. Your support fuels our mission and helps us make a real difference</p>

<a href="https://opencollective.com/Ankidroid/donate" target="_blank">
  <img alt="Donate to AnkiDroid" src="https://opencollective.com/Ankidroid/donate/button@2x.png?color=blue" width=200 />
</a>

### [Translators](https://crowdin.com/project/ankidroid/activity-stream)

Thanks to our 1400 translators, for allowing us to be available, partially or totally, in 99 languages as of July 2022.

License
-------
* [GPL-3.0 License](https://github.com/ankidroid/Anki-Android/blob/main/COPYING)
* [AGPL-3.0 License](https://github.com/ankitects/anki/blob/main/LICENSE) for some part of the back-end
* [LGPL-3.0 License](https://github.com/ankidroid/Anki-Android/blob/main/api/COPYING.LESSER) for the AnkiDroid API

===== DOC: io-enhanced.md =====
<p align="center"><img src="screenshots/logo.png" width=381 height=224></p>

<h2 align="center">Image Occlusion Enhanced for Anki</h2>

<p align="center">
<a title="Latest (pre-)release" href="https://github.com/glutanimate/image-occlusion-enhanced/releases"><img src ="https://img.shields.io/github/release-pre/glutanimate/image-occlusion-enhanced.svg?colorB=brightgreen"></a>
<a title="License: GNU AGPLv3" href="https://github.com/glutanimate/image-occlusion-enhanced/blob/master/LICENSE"><img  src="https://img.shields.io/badge/license-GNU AGPLv3-green.svg"></a>
<a title="Rate on AnkiWeb" href="https://ankiweb.net/shared/info/1374772155"><img src="https://glutanimate.com/logos/ankiweb-rate.svg"></a>
<br>
<a title="Buy me a coffee :)" href="https://ko-fi.com/X8X0L4YV"><img src="https://img.shields.io/badge/ko--fi-contribute-%23579ebd.svg"></a>
<a title="Support me on Patreon :D" href="https://www.patreon.com/bePatron?u=7522179"><img src="https://img.shields.io/badge/patreon-support-%23f96854.svg"></a>
<a title="Follow me on Twitter" href="https://twitter.com/intent/user?screen_name=glutanimate"><img src="https://img.shields.io/twitter/follow/glutanimate.svg"></a>
</p>

> Flashcards from images – the easy way

*Image Occlusion Enhanced* is an add-on for the spaced repetition flashcard app [Anki](https://apps.ankiweb.net/) that allows you to create image-based cloze-deletions.

### Table of Contents <!-- omit in toc -->

<!-- MarkdownTOC levels="1,2,3" -->

- [Screenshots](#screenshots)
- [Installation](#installation)
- [Documentation](#documentation)
- [Building](#building)
- [Contributing](#contributing)
- [License and Credits](#license-and-credits)

<!-- /MarkdownTOC -->

### Screenshots

*Creating Cards With the Add-on:*

<img src="screenshots/screenshot-io-editor-1.png">
<img src="screenshots/screenshot-io-editor-2.png">

*Reviewing Generated Cards:*

<img src="screenshots/screenshot-io-reviewer.png">

### Installation

#### AnkiWeb <!-- omit in toc -->

The easiest way to install Image Occlusion Enhanced is through [AnkiWeb](https://ankiweb.net/shared/info/1374772155).

#### Manual installation <!-- omit in toc -->

1. Make sure you have the [latest version](https://apps.ankiweb.net/#download) of Anki 2.1 installed. Earlier releases (e.g. found in various Linux distros) do not support `.ankiaddon` packages.
2. Download the latest `.ankiaddon` package from the [releases tab](https://github.com/glutanimate/image-occlusion-enhanced/releases) (you might need to click on *Assets* below the description to reveal the download links)
3. From Anki's main window, head to *Tools* → *Add-ons*
4. Drag-and-drop the `.ankiaddon` package onto the add-ons list
5. Restart Anki

### Documentation

The installation and use of this add-on is detailed in the [Wiki](https://github.com/Glutanimate/image-occlusion-enhanced/wiki) and a [series of video tutorials on YouTube](https://www.youtube.com/playlist?list=PL3MozITKTz5YFHDGB19ypxcYfJ1ITk_6o). More information may also be found in the [AnkiWeb description](docs/description.md).

### Building

With [Anki add-on builder](https://github.com/glutanimate/anki-addon-builder/) installed:

    git clone https://github.com/glutanimate/image-occlusion-enhanced.git
    cd image-occlusion-enhanced
    aab build

For more information on the build process please refer to [`aab`'s documentation](https://github.com/glutanimate/anki-addon-builder/#usage).

### Contributing

Contributions are welcome! Please review the [contribution guidelines](./CONTRIBUTING.md) on how to:

- Report issues
- File pull requests
- Support the project as a non-developer

### License and Credits

*Image Occlusion Enhanced* is

*Copyright © 2012-2015 [Tiago Barroso](https://github.com/tmbb)*

*Copyright © 2013 [Steve AW](https://github.com/steveaw)*

*Copyright © 2016-2022 [Aristotelis P.](https://glutanimate.com/) (Glutanimate)*

With code contributions from: Damien Elmes, Kyle Mills, James Kraus, Matt Restko

-----

*Image Occlusion Enhanced* is based on [Image Occlusion 2.0](https://github.com/tmbb/image-occlusion-2) by Tiago Barroso and [Simple Picture Occlusion](https://github.com/steveaw/anki_addons) by Steve AW. All credit for the original add-ons goes to their respective authors. *Image Occlusion Enhanced* would not exist without their work.

I would also like to extend my heartfelt thanks to everyone who has helped with testing, provided suggestions, or contributed in any other way.

*Image Occlusion Enhanced* ships with the following third-party open-source software:

- [SVG Edit](https://github.com/SVG-Edit/svgedit) 2.6. Copyright (c) 2009-2012 by SVG-edit authors. Licensed under the MIT license.

- [Python Imaging Library](http://www.pythonware.com/products/pil/) (PIL) 1.1.7. Copyright (c) 1997-2011 by Secret Labs AB, Copyright (c) 1995-2011 by Fredrik Lundh. Licensed under the [PIL license](http://www.pythonware.com/products/pil/license.htm)

- [imagesize.py](https://github.com/shibukawa/imagesize_py) v0.7.1. Copyright (c) 2016 Yoshiki Shibukawa. Licensed under the MIT license.

Image Occlusion Enhanced is free and open-source software. The add-on code that runs within Anki is released under the GNU AGPLv3 license, extended by a number of additional terms. For more information please see the [LICENSE](https://github.com/glutanimate/image-occlusion-enhanced/blob/master/LICENSE) file that accompanied this program.

This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY.

----
<b>
<div align="center">The continued development of this add-on is made possible <br>thanks to my <a href="https://www.patreon.com/glutanimate">Patreon</a> and <a href="https://ko-fi.com/X8X0L4YV">Ko-Fi</a> supporters.
<br>You guys rock ❤️ !</div>
</b>