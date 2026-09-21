// Assemble atra-4b-eval.ipynb from the cell sources in ./cells and the ATRA
// repository files the evaluation needs.
//
// The harness is NOT hand-pasted into the notebook: every file in CARRIED is
// read from the working tree at generation time and embedded as base64, with
// its digest embedded beside it. Regenerating the notebook therefore refreshes
// evaluate.py, prompting.py, the data package and config/default.yaml in one
// step, and the kernel asserts each digest before it runs.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const HERE = __dirname;
const CELLS = path.join(HERE, 'cells');
const REPO = 'C:/ATRA/model/atra-4b';

const CARRIED = [
  'evaluate.py',
  'prompting.py',
  'export.py',
  'config/default.yaml',
  'data/__init__.py',
  'data/schema.py',
  'data/build.py',
  'data/checks.py',
];

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function filesBlock() {
  const lines = [];
  for (const rel of CARRIED) {
    const raw = fs.readFileSync(path.join(REPO, rel));
    const b64 = raw.toString('base64');
    const chunks = b64.match(/.{1,72}/g) || [''];
    lines.push(`    ${JSON.stringify(rel)}: (`);
    for (const chunk of chunks) lines.push(`        "${chunk}"`);
    lines.push('    ),');
  }
  return lines.join('\n');
}

function expectedBlock() {
  return CARRIED.map((rel) => {
    const raw = fs.readFileSync(path.join(REPO, rel));
    return `    ${JSON.stringify(rel)}: "${sha256(raw)}",`;
  }).join('\n');
}

const TEST_SHA = sha256(fs.readFileSync(path.join(REPO, 'data/out/test.jsonl')));

function code(file) {
  let src = fs.readFileSync(path.join(CELLS, file), 'utf8').replace(/\r\n/g, '\n');
  if (src.includes('#@FILES@#')) src = src.replace('#@FILES@#', filesBlock());
  if (src.includes('#@EXPECTED@#')) src = src.replace('#@EXPECTED@#', expectedBlock());
  if (src.includes('#@TESTSHA@#')) src = src.replace('#@TESTSHA@#', TEST_SHA);
  return { cell_type: 'code', execution_count: null, metadata: {}, outputs: [], source: split(src) };
}

function md(text) {
  return { cell_type: 'markdown', metadata: {}, source: split(text.replace(/\r\n/g, '\n')) };
}

function split(src) {
  const withoutTrailing = src.replace(/\n+$/, '');
  const parts = withoutTrailing.split('\n');
  return parts.map((line, i) => (i === parts.length - 1 ? line : line + '\n'));
}

const cells = [
  md([
    '# ATRA-4B — does the *served* q4_k_m GGUF meet the thresholds?',
    '',
    'The continuation run `atra12/atra-4b-continuation-20260921` added 400 steps',
    'to the original adapter with the trainer bugs fixed, and `evaluate.py`',
    'returned exit code 0 on it — against the **adapter, through transformers**.',
    'That run recorded `deployment_validated: false` in its own result, because',
    'what anyone downloads and runs is not the adapter: it is the q4_k_m GGUF',
    'served by `llama-server`.',
    '',
    'That path has produced two wrong answers in this project already:',
    '',
    '1. the exported GGUF carried **no chat template**, so llama-server fell back',
    '   to a built-in default with no `tools` block and every training prompt',
    '   shape was lost — prompts arrived at 91 tokens;',
    "2. sending `tools` switched on llama.cpp's tool-call parser, which moved the",
    "   model's reply out of `message.content`, and the scorer read almost",
    '   nothing.',
    '',
    'Both are fixed in `train.py` (writes `chat_template.jinja` beside the',
    'weights), `export.py` (recovers a template, refuses to export without one,',
    're-reads the merged directory to prove it survived) and `evaluate.py` (sends',
    'the tools, reads `tool_calls`, and counts generated tokens against the',
    'tokens that reached the scorer). This kernel tests whether they are fixed',
    '**in the artifact**.',
    '',
    'Nothing here is tuned. The thresholds come from the repository\'s own',
    '`config/default.yaml`, carried byte-for-byte and digest-checked; the test',
    'split is rebuilt with the exact command the thresholds were written for; the',
    'exit code is reported as it comes. **A failure is the useful outcome if it',
    'is the true one** — it would mean the served path still differs from the',
    'trained one, which is precisely what this run exists to detect.',
    '',
    '## What the run does',
    '',
    '1. pinned dependencies, minus torchao;',
    '2. the **new** adapter staged from the continuation kernel (nothing is',
    '   retrained), with its `chat_template.jinja`;',
    '3. merged into `Qwen/Qwen3-4B-Instruct-2507` and converted to q4_k_m;',
    '4. the template read back **out of the GGUF** and rendered, with and without',
    '   tools, before anything is served;',
    '5. `llama-server` given the GGUF and `--jinja` and *nothing else* — no',
    '   `--chat-template-file`, because patching the template on the command line',
    '   would fix the measurement and not the artifact;',
    '6. the test split rebuilt with',
    '   `python -m data.build --seed 42 --per-domain 200 --out data/out`;',
    '7. `evaluate.py` run twice against that one server: once on',
    '   `/v1/chat/completions` with the tools (how the runtime and Ollama talk to',
    '   it) and once on `/completion` with the prompt rendered by',
    '   `prompting.render_example` (how training rendered it). Same weights, same',
    '   split, same thresholds; the two differ only in who renders and who',
    '   parses.',
  ].join('\n')),
  code('01-env.py'),

  md('## 1. Dependencies\n\nThe training run\'s pins, minus torchao.'),
  code('03-deps.sh'),

  md([
    '## 2. The repository files',
    '',
    '`evaluate.py`, `prompting.py`, `export.py`, the `data` package and',
    '`config/default.yaml`, carried verbatim rather than cloned, so the run',
    'cannot silently score against a different revision than the one the result',
    'is reported for. Each digest is compared in-kernel against the working tree',
    'as it stood when this notebook was generated.',
  ].join('\n')),
  code('05-files.py'),

  md([
    '## 3. The new adapter',
    '',
    '400 steps, final loss 0.0980891, `status: completed` — and, unlike its',
    'parent, a `chat_template.jinja` beside the weights.',
  ].join('\n')),
  code('07-adapter.py'),

  md([
    '### 3.1 Which template path will `export.py` take?',
    '',
    '`export.py` uses the adapter\'s own tokenizer template when it has one and',
    'falls back to the base model only when it does not. Which of the two',
    'happened is worth knowing exactly, so it is established before the merge and',
    'confirmed from the merge log afterwards.',
  ].join('\n')),
  code('08-template.py'),

  md([
    '## 4. llama.cpp: converter, quantizer and server',
    '',
    'The CUDA build failed to configure on this image last time — FindCUDAToolkit',
    'could not resolve `CUDA::cuda_driver` — so the driver library is pointed at',
    'explicitly, with a CPU fallback that costs time and not correctness.',
  ].join('\n')),
  code('09-llama.sh'),

  md('## 5. Merge and convert'),
  code('11-merge.sh'),

  md([
    '## 6. The template inside the artifact',
    '',
    'Everything above is about the adapter and the exporter. This opens the',
    'q4_k_m file itself, reads `tokenizer.chat_template` out of its metadata, and',
    'renders it both ways. If the tools do not appear here, they will not appear',
    'for anyone who downloads this file, and the run stops.',
  ].join('\n')),
  code('12-gguf-template.py'),

  md([
    '## 7. The test set',
    '',
    'Rebuilt deterministically, with the seed and per-domain count the thresholds',
    'were written for, rather than carried: the build is the specification. The',
    'digest is then compared with the working tree\'s copy, so "the same 95',
    'examples" is checked rather than assumed.',
  ].join('\n')),
  code('13-data.sh'),
  code('14-data-check.py'),

  md([
    '## 8. Serve the GGUF — with nothing but `--jinja`',
    '',
    'No `--chat-template-file`. The template being used has to be the one inside',
    'the file, or the measurement describes a server configuration nobody else',
    'will have.',
  ].join('\n')),
  code('15-serve.py'),

  md([
    '## 9. What the served model actually says',
    '',
    'The prompt-shape check first: the same prompt sent with and without the tool',
    'block, so the token counts show whether the schemas survive the trip. 91',
    'tokens either way was the signature of failure #1. Then the same example',
    'through `/completion` with the prompt rendered locally, and one example per',
    'domain printed in full beside the expected answer.',
  ].join('\n')),
  code('17-probe.py'),

  md('## 10. Evaluate — both serving paths, one server, one split'),
  code('19-evaluate.sh'),

  md([
    '## 11. Did the tools reach the model, and did the replies reach the scorer?',
    '',
    'From two independent records: the per-reply trace `evaluate.py` wrote, and',
    "llama-server's own log. `replies_losing_content` is the number that decides",
    'whether any of the metrics below may be quoted at all.',
  ].join('\n')),
  code('20-tokens.py'),

  md('## 12. Result'),
  code('21-report.py'),

  md([
    '## 13. What is kept',
    '',
    '- `eval-chat.json`, `eval-raw.json` — the two results, thresholds included',
    '- `trace-chat.jsonl`, `trace-raw.jsonl` — every reply with its token accounting',
    '- `atra-4b-q4_k_m.gguf` + `Modelfile` — the exact artifact that was evaluated',
    '- `export-manifest.json`, `export.log` — adapter, base revision, training manifest',
    '- `gguf-chat-template.jinja` — the template read back out of the GGUF',
    '- `evaluate-*-stdout.txt`, `evaluate-*-exit-code.txt`, `data-checks.txt`',
    '',
    'Whether the repository\'s UNTRAINED label changes is decided by the numbers',
    'above, and not in this notebook.',
  ].join('\n')),
  code('23-cleanup.sh'),
];

const notebook = {
  cells,
  metadata: {
    kernelspec: { display_name: 'Python 3', language: 'python', name: 'python3' },
    language_info: { name: 'python', version: '3.12.13' },
  },
  nbformat: 4,
  nbformat_minor: 5,
};

const out = path.join(HERE, 'atra-4b-eval.ipynb');
fs.writeFileSync(out, JSON.stringify(notebook, null, 1), 'utf8');
console.log(`wrote ${out} (${fs.statSync(out).size} bytes, ${cells.length} cells)`);
console.log('carried file digests:');
for (const rel of CARRIED) {
  console.log(`  ${sha256(fs.readFileSync(path.join(REPO, rel)))}  ${rel}`);
}
console.log(`  ${TEST_SHA}  data/out/test.jsonl (expectation only, rebuilt in kernel)`);
