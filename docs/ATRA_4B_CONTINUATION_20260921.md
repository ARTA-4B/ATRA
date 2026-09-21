# ATRA-4B continuation — 2026-09-21

## Submission

The operator requested training. A private Kaggle job was submitted:
[atra12/atra-4b-continuation-20260921](https://www.kaggle.com/code/atra12/atra-4b-continuation-20260921), version 1.
Kaggle reported `RUNNING` after submission. This is a job status, not proof of training completion or evaluation success.

## Verified parent

The manifest downloaded from `atra12/atra-4b-adapter-v0` records:

- Completed training, 200 optimizer steps, two epochs, 800 training examples.
- 105 validation examples and 95 test examples.
- Tesla T4; 14,582.73 seconds; final training loss 0.2063367792.
- Base revision `f12db89cd5156e090618dded9b4367f23f8f3b33`.
- Train/validation dataset hash `3e4faf65d137ce723e626ba975fe147a1fd7466ea51819afcf341d36f16632eb`.

Thus old documentation saying no training has completed is stale. The release label remains `UNTRAINED` pending the project's acceptance requirements. The parent training loss does not establish model capability, and the previous parser-contaminated evaluation cannot determine the required training duration.

## Changes and fixed run plan

The original trainer supplied a `text` dataset and never applied the configured `train_on_completions_only` option. The corrected trainer uses prompt/completion pairs and explicitly enables completion-only loss. This follows [TRL 0.27 documentation](https://huggingface.co/docs/trl/v0.27.0/en/sft_trainer#train-on-completion-only). A preflight checks the real TRL collator masks prompt labels and rejects examples that would truncate answers.

Continue the existing adapter with a new optimizer: four additional epochs, approximately 400 optimizer steps, learning rate 0.0001. Preserve the original seed, dataset, base revision, chat template and evaluation thresholds. This is a bounded training attempt, not a claim that 600 cumulative steps guarantee success.

1. Verify source hashes, GPU availability, dataset hash and 37 pipeline tests.
2. Evaluate the parent on validation data using direct Transformers generation.
3. Train; measure validation loss each epoch and save the best checkpoint.
4. Evaluate the selected adapter on validation and then test data.
5. Save complete raw replies, metrics, adapter, tokenizer/template, manifests and logs.

Direct generation bypasses llama.cpp's tool-call parser. It measures the NF4 adapter, not GGUF quality or the deployed serving path. Deployment acceptance remains separate. The test split is not used for checkpoint selection and thresholds are unchanged.

Kaggle job timeout: 12 hours. The parent took about four hours for 200 steps, so the continuation can take several hours. No paid GPU service was created.

## Files and monitoring

- Build job: `node model/atra-4b/kaggle/build-continuation.mjs`.
- Local submitted script/metadata: `artifacts/atra-training-20260921/kernel/`.
- Parent manifest: `artifacts/atra-training-20260921/manifest.json`.
- Watcher: `model/atra-4b/kaggle/watch-continuation.ps1`.
- Watch status and downloaded outputs: `artifacts/atra-training-20260921/remote/`.
- Remote final verdict: `result.json`; full scores: `final-test.json`.

The watcher downloads outputs after the job ends, including failure logs if it fails. It does not deploy the model or alter the release label. `COMPLETE` means the script completed; read the evaluation verdict separately.
