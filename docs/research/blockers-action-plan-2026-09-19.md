# ATRA — Decisive Action Plan for the Three Blockers (2026-09-19)

Label vocabulary used in every phase report from here on: `VERIFIED-LOCAL`, `VERIFIED-CI`, `UNVERIFIED (<reason>)`, `UNMEASURED`, `DESIGN-TARGET`, `UNTRAINED`, `BLOCKED-<issue>`.

---

## Blocker 1 — Local Docker / docker-compose on Windows 11 Home 25H2 (26200.9457)

### 1.1 Decision
- **Source of truth = GitHub Actions** on a **public** repo `sighttrue/atra` (ubuntu-24.04 runner: Docker 28.0.4 + Compose v2 2.38.2, free/unlimited minutes). Every push runs `docker compose config → build → up --wait → /health`.
- **Local = WSL2 Ubuntu-24.04 + Docker Engine + compose plugin** (Apache-2.0, no Docker Desktop), driven from Windows via `wsl -d Ubuntu-24.04 -e docker compose ...`. Time-boxed: one install attempt + one diagnostic; no hours sunk into microsoft/WSL #41635.
- **Local GUI fallback** (only if native `docker.exe`/GUI is wanted): Docker Desktop 4.91.0 **per-user** install (`install --user`) — "works in practice, officially ambiguous on Home"; or Rancher Desktop 1.24.0 (Apache-2.0, docs explicitly list Home). Both still require WSL2.
- **If WSL2 cannot create a VM** (#41635 signature): stop local work, use **GitHub Codespaces** (docker-in-docker, 120 core-h/month) for interactive debugging; CI remains the gate.
- **Skip**: Podman Desktop (not what ATRA docs will tell users), Cloudflare Sandbox/Containers (Workers Paid $5/mo, iptables disabled), Vercel Sandbox (team plan unverified; keep as optional agent-driven smoke only), Google Cloud Shell (manual only; Google account unverified).

### 1.2 Steps

**Claude runs now (non-interactive, no admin):**
1. Scaffold `C:\ATRA`: `Dockerfile` with `HEALTHCHECK`, `docker-compose.yml` with `healthcheck:`, `.env.example`, an `ATRA_MODE=ci` offline mode (boots with no provider keys, no Telegram, no gateway) and a `/health` route so `--wait` is meaningful.
2. Add `.github/workflows/docker-smoke.yml` (port/path to be replaced with the dashboard's real values):
   ```yaml
   name: docker-smoke
   on: { push: {}, pull_request: {}, workflow_dispatch: {} }
   jobs:
     compose-smoke:
       runs-on: ubuntu-24.04
       timeout-minutes: 20
       steps:
         - uses: actions/checkout@v4
         - run: docker version && docker compose version
         - run: cp .env.example .env && docker compose config --quiet
         - run: docker compose build --pull
         - run: docker compose up -d --wait --wait-timeout 120
         - run: |
             for i in $(seq 1 30); do curl -fsS http://localhost:3000/health && exit 0; sleep 2; done
             echo 'health check failed'; exit 1
         - if: failure()
           run: docker compose ps; docker compose logs --no-color --tail=200
         - if: always()
           run: docker compose down -v --remove-orphans
   ```
3. `gh repo create sighttrue/atra --public --source=C:\ATRA --push` then `gh workflow run docker-smoke.yml; gh run watch; gh run view --log-failed` (gh token already has `repo`+`workflow`).
4. Write `%USERPROFILE%\.wslconfig` (takes effect after U2):
   ```
   [wsl2]
   memory=6GB
   processors=4
   swap=2GB
   [experimental]
   autoMemoryReclaim=gradual
   sparseVhd=true
   ```
   (Raise `memory` to 12GB only for a training session — see Blocker 2 — then `wsl --shutdown`.)
5. Prepare `scripts/wsl-docker-install.sh` = the verbatim Docker Engine commands from https://docs.docker.com/engine/install/ubuntu/ (apt keyring, `docker.sources`, `docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin`).

**User runs (interactive: UAC, reboot, prompts):**
- **U1.** In a normal PowerShell on the desktop: `wsl --install --no-distribution`. Expect the text "The requested operation requires elevation." followed by a **secure-desktop UAC Yes/No consent prompt** (you are in local Administrators; click Yes). Expect "The requested operation is successful. Changes will not be effective until the system is rebooted." → **reboot**. Do not enable Windows "Administrator protection" (Microsoft advises against it on WSL machines). Do not use `winget install Microsoft.WSL` (2.7.13 msixbundle, lags); the installer lands on 2.7.14 today.
- **U2.** After reboot, normal PowerShell:
  1. `wsl --version` → expect 2.7.14.
  2. Cheap discriminating test before pulling a distro: `hcsdiag hostproperties processortopology` and `Get-WinEvent -LogName Microsoft-Windows-Hyper-V-Compute-Admin -MaxEvents 50 | Where-Object Id -eq 11008`. Normal topology table and no Event 11008 → continue. "Catastrophic failure" 0x8000FFFF or Event 11008 → this machine matches #41635; skip to the Codespaces fallback and, only if you want to chase it: elevated `bcdedit /enum {current}` (remove `disabledynamictick`/`useplatformclock`/`useplatformtick` tweaks), confirm Secure Boot in User mode, uninstall any VirtualBox/VMware, consider temporarily uninstalling Riot Vanguard (`vgk` is running here; causal link unverified). Note: a Repair install of the WSL MSI fixes #40488 (ERROR_FILE_NOT_FOUND) only, not an HCS failure.
  3. `wsl --set-default-version 2; wsl --install -d Ubuntu-24.04` → create the Linux username/password when prompted.
  4. `wsl --shutdown` (applies `.wslconfig`).
- **U3.** Hand back to Claude.

**Claude runs after U2 (non-interactive, via `wsl -d Ubuntu-24.04 -u root -e bash -lc '...'`, no sudo prompts):**
6. Check `/etc/wsl.conf` contains `[boot]\nsystemd=true` (add if missing, then `wsl --shutdown` from PowerShell); `systemctl is-system-running`.
7. Run `scripts/wsl-docker-install.sh`; `usermod -aG docker <linuxuser>`; `systemctl enable --now docker`; `docker run --rm hello-world`; `docker compose version`.
8. `git clone https://github.com/sighttrue/atra ~/atra && cd ~/atra && docker compose up -d --build --wait --wait-timeout 120 && curl -fsS http://localhost:<port>/health`. From Windows: `wsl -d Ubuntu-24.04 -e docker compose -f /mnt/c/ATRA/docker-compose.yml up -d --wait`; dashboard reachable at `http://localhost:<port>` (localhostForwarding is on by default).
9. Optional Windows-native CLI: `winget install --id Docker.DockerCLI --exact; winget install --id Docker.DockerCompose --exact`, make dockerd also listen on `tcp://127.0.0.1:2375` in `/etc/docker/daemon.json`, then `docker context create wsl --docker host=tcp://127.0.0.1:2375; docker context use wsl`.

**Fallbacks (user-run unless noted):**
- Docker Desktop per-user (installer step needs no admin; WSL2 enabling in U1 was the one-time elevation): download https://desktop.docker.com/win/main/amd64/239619/Docker%20Desktop%20Installer.exe (628 MB, SHA256 ac405b09…311ac) and run `Start-Process 'Docker Desktop Installer.exe' -Wait -ArgumentList 'install','--user','--accept-license','--backend=wsl-2','--no-windows-containers'`, **or** `winget install --id Docker.DockerDesktop -e --custom "--user"`. Never `--scope user` (no user-scope installer exists; winget-pkgs #382764); a bare `winget install Docker.DockerDesktop` is an all-users install with the installer's own UAC prompt. Accept the SSA on first start (free for personal use / non-commercial OSS / <250 employees and <$10M). Docker VMM (Beta) backend exists in per-user mode but is unverified on Home; experiment only.
- Rancher Desktop: `winget install --id SUSE.RancherDesktop --exact` (671 MB MSI), decline the Privileged Service (ports bind to 127.0.0.1 only), engine = dockerd, disable Kubernetes.
- Codespaces: user runs `gh auth refresh -h github.com -s codespace` (browser OAuth; current token lacks the scope). Claude then adds `.devcontainer/devcontainer.json` (`mcr.microsoft.com/devcontainers/base:ubuntu-24.04` + `ghcr.io/devcontainers/features/docker-in-docker:2`, `forwardPorts:[3000]`), runs `gh codespace create -R sighttrue/atra -m basicLinux32gb`, `gh codespace ssh -- 'cd atra && docker compose up -d --build --wait && curl -fsS http://localhost:3000/health'`, `gh codespace stop`, `gh codespace delete` when done. Never use real keys/wallets there.

### 1.3 Cost
$0. Downloads: WSL MSI 259 MB, Ubuntu ~1 GB, Docker Engine a few hundred MB (Docker Desktop 628 MB / Rancher 671 MB if used). GitHub Actions: free and unlimited on public repos (4 vCPU/16 GB/14 GB SSD, 6 h/job; private would be 2,000 min/month). Codespaces: 120 core-hours + 15 GB-month free, blocked (not billed) at quota. Docker Desktop: $0 for this project's status.

### 1.4 Honestly untestable today → labels
- WSL2 VM creation on this Lenovo LOQ 15ARP10E: unknown until U1/U2. #41635 is an unacknowledged two-reporter issue (AMD 7840HS Zen 4 and Intel i9-14900KF; reproduced on 26200.8037 too, so not build-specific; sibling #41527 was local misconfiguration). Report as `LOCAL DOCKER: UNVERIFIED (WSL2 not installed)` → later `VERIFIED-LOCAL` or `BLOCKED-#41635`. Worst realistic outcome of `wsl --install` is a non-destructive CreateVm failure, not an unbootable machine (#40344's trigger cannot occur: the hypervisor already starts at every boot, Hyper-V-Hypervisor Event ID 1).
- Docker Desktop on Windows Home: Docker's install page lists only Enterprise/Pro/Education since docs PR #23584 (2025-10-23, never restored; #23600 re-added Win10 without Home); no Docker statement exists; free users have no support channel. ATRA user docs wording: "runs via the WSL 2 backend (Linux containers only) but is not listed in Docker's system requirements and not covered by Docker support". Never "officially supported on Home".
- systemd default in the Ubuntu-24.04 WSL image and any iptables-legacy need: `UNVERIFIED` until step 6/7.
- Literal BCD `hypervisorlaunchtype`: `UNVERIFIED (needs elevation)`; effect is verified (hypervisor launches every boot).
- Vercel team `robin-index` plan and a Google account for Cloud Shell: `UNVERIFIED`, not used.
- Compose major line: CI validates on Compose v2 2.38.2; Rancher bundles 5.3.1, winget 5.5.1. Report as "compose file validated on v2 2.38.2 (CI)" plus the local version if any.
- 24/7 soak behaviour: not exercised by CI, Codespaces or any sandbox. Report `24/7 SOAK: NOT TESTED` until a local runtime has run for days.

---

## Blocker 2 — ATRA-4B fine-tune (reproducible QLoRA/LoRA pipeline)

### 2.1 Decision
- **Base for ATRA-4B v0: `Qwen/Qwen3-4B-Instruct-2507`** (Apache-2.0, dense, 262K ctx, Hermes-style `<tool_call>` template; Unsloth notebook exists). v1 upgrade candidates once a 16 GB+ GPU is used: `Qwen/Qwen3.5-4B` (Apache-2.0; Unsloth: bf16 LoRA 10 GB, QLoRA "not recommended") or `google/gemma-4-E4B-it` (Apache-2.0; QLoRA 10 GB). Not Llama 3.2 3B as primary (gated, naming/"Built with Llama" obligations).
- **Pipeline proof (do first, local):** one `train.py` (Unsloth + TRL), smoke-tested on `unsloth/Qwen3-0.6B` in **WSL2 Ubuntu-24.04** (shares Blocker 1's install; keeps the Windows NVIDIA driver 610.62; nothing GPU-related installed inside WSL). Native Windows is viable only with explicit pins (below) and is second-class.
- **Local 4B QLoRA on the RTX 3050 6 GB is UNMEASURED and expected marginal**, not "fits per Unsloth's table". Run it as a measured experiment (plain NF4 checkpoint, seq 1024) after the smoke test; do not plan the release on it.
- **Real training run: Kaggle T4x2** (fp16; 30 GPU-h/week; 12 h "Save & Run All" sessions), Colab free T4 as backup (best-effort, ~90 min idle disconnect), **RunPod Community RTX 3090/4090 (~$1 per run)** if free tiers fail twice. Checkpoints pushed to a private HF Hub repo (`hub_strategy='checkpoint'`) for resume.
- **Release honesty:** if no real run has happened, ship ATRA-4B as the pinned upstream GGUF + ATRA system prompt/tool schemas/Modelfile + `train.py`, labeled `UNTRAINED`.
- **Serving:** on the user's machine via Ollama (Modelfile `FROM` the Q4_K_M GGUF, template copied from `ollama show qwen3:4b --modelfile`) or llama.cpp `llama-server --jinja`. 4B Q4_K_M (~2.5 GB) fits fully in 6 GB VRAM. The gateway does **not** host ATRA-4B (see Blocker 3).

### 2.2 Steps

**Claude runs now (non-interactive):**
1. Write `training/train.py` (model chosen by env var so the same script serves smoke, local 4B experiment, Kaggle/Colab, RunPod): `PYTORCH_CUDA_ALLOC_CONF=expandable_segments:True` set before importing torch; `FastLanguageModel.from_pretrained(model_name=os.environ.get('ATRA_BASE','unsloth/Qwen3-4B-Instruct-2507'), max_seq_length=int(os.environ.get('ATRA_SEQ','2048')), load_in_4bit=True, dtype=None)`; `get_peft_model(r=16, lora_alpha=16, lora_dropout=0, target_modules=[q,k,v,o,gate,up,down], use_gradient_checkpointing='unsloth', random_state=42)`; `SFTConfig(per_device_train_batch_size=1, gradient_accumulation_steps=8, max_length=<ATRA_SEQ>, num_train_epochs=2, learning_rate=2e-4, lr_scheduler_type='cosine', warmup_ratio=0.03, optim='paged_adamw_8bit', bf16=torch.cuda.is_bf16_supported(), fp16=not torch.cuda.is_bf16_supported(), logging_steps=5, save_strategy='steps', save_steps=50, save_total_limit=2, dataset_num_proc=1, report_to='none', push_to_hub=<ATRA_PUSH>, hub_model_id='sighttrue/atra-4b-lora', hub_private_repo=True, hub_strategy='checkpoint')`; `resume_from_checkpoint=os.environ.get('ATRA_RESUME')`. Data rendered with `tok.apply_chat_template(messages, tools=tools, tokenize=False)` (non-thinking variant, no `<think>`). Startup assertion: fail if the Unsloth banner prints "Switching to 16bit LoRA". In WSL2 call `torch.cuda.set_per_process_memory_fraction(1.0, 0)` so the NVIDIA sysmem fallback cannot mask an OOM (microsoft/WSL #11050). Log `torch.cuda.max_memory_reserved()`, `torch.cuda.mem_get_info()` and `nvidia-smi` peak at the end.
2. Write `training/validate_dataset.py` (CPU only): renders 100 samples through the chat template with tools, checks every assistant `tool_call` parses as JSON against the ATRA tool schemas, diffs tokenizer/chat_template hash against the pinned upstream revision.
3. Write `training/export.py`: `save_pretrained_merged(..., save_method='merged_16bit')` → `save_pretrained_gguf(..., quantization_method='q4_k_m')`; `training/Modelfile`; `training/kaggle_train.ipynb` (same script, `CUDA_VISIBLE_DEVICES=0`, fp16, HF_TOKEN from Kaggle Secrets); `training/MODEL_CARD.md` with the UNTRAINED text below.
4. After WSL2 Ubuntu exists (Blocker 1 U2), inside it as the Linux user: `python3 -m venv ~/atra-train && . ~/atra-train/bin/activate && pip install torch==2.12.1 torchvision --index-url https://download.pytorch.org/whl/cu130 && pip install unsloth` (torch pinned <2.13 because `unsloth 2026.9.7` declares `torch<2.13.0`; Linux triton comes with torch). Temporarily set `.wslconfig` `memory=12GB`, `wsl --shutdown`.
5. Smoke: `ATRA_BASE=unsloth/Qwen3-0.6B ATRA_SEQ=1024 ATRA_PUSH=0 python train.py --max_steps 30` → assert loss decreases, `checkpoint-50`/resume works, merged_16bit + GGUF export succeed; download the llama.cpp Windows CUDA prebuilt zip (`llama-bXXXX-bin-win-cuda-12.4-x64.zip` + cudart zip from https://github.com/ggml-org/llama.cpp/releases), run `llama-server -m out.Q4_K_M.gguf --jinja -ngl 99 -c 8192 --port 8080` and assert a syntactically valid `tool_call` for a fixed prompt.
6. 4B fit measurement (experiment, not release path): `ATRA_BASE=unsloth/Qwen3-4B-Instruct-2507-bnb-4bit ATRA_SEQ=1024 python train.py --max_steps 10` (explicit `-bnb-4bit` name = plain NF4 2.47 GiB; the default mapping to `-unsloth-bnb-4bit` loads 3.30 GiB). Pass = `max_memory_reserved` ≤ 5.5 GiB on the 6144 MiB card with dense, real-length tool-call samples; then retry seq 2048; run the eval/generate step at batch 1 with short `max_new_tokens` (the only public run peaked 6.36–6.46 GiB in eval). Fallback that certainly fits: `Qwen3-1.7B` (smoke only).
7. Native-Windows alternative only if WSL2 is blocked (no admin for pip; see U-items): fresh Python 3.11/3.12 venv (not the Hermes venv), `pip install --index-url https://download.pytorch.org/whl/cu130 "unsloth[cu130-torch2121]"`, `pip install -U "triton-windows<3.8"`, `pip install "bitsandbytes>=0.50.2"`, `dataset_num_proc=1`; or Unsloth's own `irm https://unsloth.ai/install.ps1 | iex` (pins torch 2.11 + triton-windows<3.7). Never the docs' bare `pip3 install torch … cu130` followed by `pip install unsloth` (yields torch 2.14 then a CPU-only downgrade). VS Build Tools are not required (TinyCC/ptxas bundled).

**User runs (interactive/accounts):**
- **U1.** Same WSL2 enable + reboot as Blocker 1 (no extra admin). Native-Windows path only: NVIDIA Control Panel → Manage 3D Settings → "CUDA - Sysmem Fallback Policy" = "Prefer No Sysmem Fallback"; enable Windows long paths; install VC++ 2015–2022 redistributable.
- **U2.** Hugging Face account + write token (for private checkpoint repo `sighttrue/atra-4b-lora`); provide it as `HF_TOKEN` in WSL env / Kaggle Secrets / Colab Secrets (never paste into chat).
- **U3.** Kaggle: phone-verified account (required for GPU); upload `training/kaggle_train.ipynb`, accelerator **T4 x2**, "Save & Run All" (12 h cap; runs detached). Note TPU needs Persona ID verification since 2026-01-28 — do not use TPU.
- **U4.** Colab backup: open Unsloth-style notebook, keep the tab active (no background execution on free; ~90 min idle disconnect); or, from WSL2, `colab run --gpu T4 train.py` (Colab CLI is Linux/macOS only; never `colab ssh` on free).
- **U5.** Paid fallback: RunPod account with a card; launch Community Cloud RTX 3090 ($0.22/h) or 4090 ($0.34/h) with the `unsloth/unsloth` image (`docker run -d -e JUPYTER_PASSWORD=... -p 8888:8888 --gpus all unsloth/unsloth`); Claude supplies the exact commands.

### 2.3 Cost
$0 for local smoke, Kaggle (30 GPU-h/week floor, resets Saturday 00:00 UTC) and Colab free. Paid fallback ≈ $0.66 (3090) / $1.02 (4090) for a 3 h run on RunPod, ≈ $0.73 on Vast A10; Lambda A10 $1.29/h not recommended. HF Hub private checkpoints free (100 GB). Disk ~10–15 GB for env + models. Sizing reference: Unsloth's committed T4 output shows ~9.5 s/step at effective batch 8 × 2048 tokens, i.e. 1–3 h ≈ 380–1,100 steps ≈ 3k–9k examples per session.

### 2.4 Honestly untestable today → labels
- 4B QLoRA peak VRAM on 6 GB: `UNMEASURED` until step 6 (derived expectation: dynamic quant 4.8–5.6 GiB at seq 2048, ~4.3–4.9 GiB at seq 1024, plain NF4 ~0.8 GiB lower — estimates, not measurements). Unsloth publishes no 4B figure and its 3B/7B rows do not interpolate to Qwen3.
- Tool-calling quality after SFT: no benchmark numbers exist for 4B fine-tunes. A checkpoint may be called "ATRA-4B v0.1" only after a held-out JSON-schema-validity + BFCL-style eval is published; until then `EVAL: NOT RUN`.
- Throughput/hours per epoch on the RTX 3050 and exact Kaggle/Colab availability for this account: `UNMEASURED`/`UNVERIFIED`.
- Native-Windows end-to-end QLoRA with the pinned combo: no first-party evidence; `UNVERIFIED` unless step 7 is executed.
- Gemma-4-E4B cannot be smoke-tested locally (E2B QLoRA needs 8 GB); Qwen3.5-4B custom GGUF import into Ollama has open issues (ollama/ollama#14730) — relevant only for v1; Unsloth's Qwen3.5 page changed once (2026-03-02→03) so pin the Wayback snapshot used.
- Release label (verbatim in model card, README and API metadata): "**UNTRAINED** — no fine-tuning run has been performed; weights are byte-identical to `unsloth/Qwen3-4B-Instruct-2507-GGUF`@<revision>; the pipeline has only been smoke-tested on `unsloth/Qwen3-0.6B` for N steps on an RTX 3050 (WSL2)." Never label a smoke checkpoint as ATRA-4B. After a real run: "ATRA-4B v0.1: LoRA SFT on N examples, <GPU>, <hours>, eval <link>".

---

## Blocker 3 — ATRA Gateway on Cloudflare (free-tier friendly)

### 3.1 Decision
- **Build Option A**: one Worker `atra-gateway` (wrangler environments `staging`/`production`, `compatibility_date` ≥ 2026-04-07, `nodejs_compat`), **SQLite-backed hibernating-WebSocket `Hub` Durable Object** (1 hub at launch, sharded to ~10 at 1,000 installs), **D1** for installs/tokens/pairing/links (2 of the 4 remaining free slots), **KV** for the 5-minute market snapshot (288 writes/day), **ratelimit binding** for burst protection only, **Analytics Engine** for metering, **Static Assets** for website + market page on `workers.dev`, one cron. All provider keys in Worker secrets; allowlisted upstream hosts and JSON-RPC methods; per-install daily RPC cap (~500/day on Free) counted in the Hub DO; runtime defaults to public RPC/BYOK.
- **Skip R2** (requires a payment method on file — first-party documented) → weights on Hugging Face Hub, binaries/compose/checksums on GitHub Releases (<2 GiB/asset), images on GHCR. **Skip Pages and Vercel.**
- **Do not host ATRA-4B on Workers AI** (no Qwen3/Gemma-4 base; only BYO-LoRA on 9 listed bases). Optional later: a separately trained `ATRA-Llama-3B-LoRA` on `@cf/meta/llama-3.2-3b-instruct` (unquantized base, r≤32, <300 MB, `model_type: llama`), behind an account-wide Neuron guard. Default inference stays local (Ollama/llama.cpp) or BYOK.
- **Plan to enable Workers Paid ($5/mo) before public launch**: the Free 100k requests/day is account-wide and shared with the 22 existing Workers (fail-closed 1027 for all of them if exceeded).

### 3.2 Steps

**Claude runs (non-interactive, existing wrangler OAuth with workers/kv/d1 write):**
1. Scaffold `gateway/` in the monorepo (`apps/runtime`, `apps/dashboard`, `gateway/`, `packages/shared` zod schemas). `wrangler.jsonc` per env with: `d1_databases [{binding:'DB'}]`, `kv_namespaces [{binding:'KV'}]`, `durable_objects.bindings [{name:'HUB', class_name:'Hub'}]` + `migrations [{tag:'v1', new_sqlite_classes:['Hub']}]`, `ratelimits` with **namespace_ids 2001/2002/2003 (production) and 2101/2102/2103 (staging)** — never 1001–1004, which the existing `flyscout` Worker already uses and would share counters with — `simple:{limit:60|5|10, period:60}`, `analytics_engine_datasets [{binding:'AE', dataset:'atra_usage'}]`, `assets {directory:'./site', binding:'ASSETS'}`, `triggers.crons ['*/5 * * * *']`, `observability {enabled:true, head_sampling_rate:0.2}`, `limits {cpu_ms:10, subrequests:25}`, `workers_dev:true`, route fail-closed. Top-level `ratelimits` key (wrangler 4.110 ≥ 4.36 OK).
2. `wrangler d1 create atra-gateway-staging` / `atra-gateway-production`; `wrangler kv namespace create KV --env staging|production`; write `gateway/migrations/0001_init.sql` (`install_tokens(token_hash PK, install_id, scopes, created_at, expires_at, revoked_at, rotated_from)`, `pair_codes`, `tg_links`, `tg_updates` with 24 h purge).
3. Implement: `POST /v1/install/register` (RL_REGISTER on `cf-connecting-ip`, UUIDv7 + `atra_<id>.<32 random bytes b64url>` token, store `HMAC-SHA256(TOKEN_PEPPER, token)` only via WebCrypto, 60 s in-isolate positive cache), `/v1/install/token/rotate` (300 s grace), revoke/kill-switch; `GET /v1/ws` → `env.HUB.getByName('hub-'+shard)` → `ctx.acceptWebSocket(server, ['install:'+id])` + `ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping','pong'))` (exact literal frames only; runtime pings every 2–5 min); alarm every 60 s **re-armed only while sockets are connected**, broadcast KV snapshot to `ctx.getWebSockets()`; never `ws.accept()`, `setInterval`, or outbound WebSocket/TCP inside the DO (pins it in memory, billed up to 15 min); `POST /tg/webhook` (reject mismatched `X-Telegram-Bot-Api-Secret-Token`, dedup by `(chat_id, update_id)` in D1, always 200 fast); `/pair` via atomic `UPDATE pair_codes … WHERE code=? AND used_at IS NULL AND expires_at>now RETURNING install_id` (D1, not KV); command delivery via `env.HUB…deliver()` → `ws.send`; replies via `api.telegram.org/bot<token>/sendMessage` (short awaited fetch; fine for hibernation); `POST /v1/rpc/{chain}` (batch ≤20 forwarded as one upstream request, per-chain method allowlist, hard-coded UPSTREAMS map, Cache API for idempotent reads 5–30 s); `GET /v1/market/*` from KV with `Cache-Control` so `ctx.cache` answers repeats; usage flushed to DO SQLite every 60 s and `AE.writeDataPoint` with head sampling.
4. `wrangler deploy --env staging`; `wrangler d1 migrations apply DB --env staging`; then production. `.github/workflows/gateway-deploy.yml` with `cloudflare/wrangler-action` (needs `CLOUDFLARE_API_TOKEN` repo secret — see U4).
5. Owed verification tests on staging (throwaway `HubTest` DO, deployed Worker, not `wrangler dev`):
   - **T-heartbeat:** one hibernated WS sending literal `ping` every 60 s, auto-response set, **alarm disabled**; compare `requests` in `durableObjectsInvocationsAdaptiveGroups` filtered to the DO id over 1 h with vs. without the auto-response pair. Expected: zero growth (workerd short-circuits auto-responses before any invocation).
   - **T-alarm:** 60 s self-rescheduling alarm, no sockets; log a per-instance random ID in the constructor; expected: new ID at every alarm (evicted between alarms) and near-zero GB-s between alarms.
   - **T-load:** Node script from this laptop opening 100 WSS connections to staging, 30 commands/day-equivalent and ≤500 RPC calls/install; read the account-wide daily request counter afterwards.
   - Claude queries GraphQL analytics; if the OAuth token is refused, the user reads the Durable Objects Metrics tab (filter by DO id/name).
6. Optional Workers AI path (only after a real Llama-3.2-3B LoRA training run): `wrangler ai finetune create @cf/meta/llama-3.2-3b-instruct atra-3b-lora ./adapter`; `POST /v1/ai/chat` calling `env.AI.run(model, {messages, lora:'atra-3b-lora'})` behind the install quota and a daily guard that stops at ~9,000 Neurons/day; responses carry `model_status: UNTRAINED` until then.

**User runs (interactive/dashboard/secrets):**
- **U1.** Telegram @BotFather: create **two** bots (production + staging; `getUpdates` is disabled while a webhook is set, so staging needs its own bot).
- **U2.** `wrangler secret put <NAME> --env production` (and `--env staging`) for `TELEGRAM_BOT_TOKEN`, `TELEGRAM_WEBHOOK_SECRET` (1–256 chars `[A-Za-z0-9_-]`), `TOKEN_PEPPER`, `RPC_KEY_BASE`, `RPC_KEY_BSC`, `RPC_KEY_SOLANA`, `RPC_KEY_ROBINHOOD`, `MARKET_API_KEY` — run these yourself so secret values never enter the transcript. Sign up for the RPC/market-data providers you choose (their free tiers are unverified).
- **U3.** Set the webhook once per env: `curl "https://api.telegram.org/bot<token>/setWebhook?url=https://<gateway>/tg/webhook&secret_token=<TELEGRAM_WEBHOOK_SECRET>&allowed_updates=%5B%22message%22,%22callback_query%22%5D"`.
- **U4.** Cloudflare dashboard: (a) confirm the account plan (Free vs Paid) and current daily request usage of the 22 Workers — the wrangler OAuth token has no billing scope, so Claude cannot; (b) create a scoped API token (Workers Scripts:Edit, D1:Edit, KV:Edit, Account Settings:Read) and run `gh secret set CLOUDFLARE_API_TOKEN -R sighttrue/atra` yourself; (c) if `wrangler deploy` errors on the AE binding, enable Analytics Engine once in the dashboard (unverified requirement noted in the flyscout config); (d) decide on Workers Paid ($5/mo) before public launch; (e) optionally buy/move a domain to Cloudflare (a zone is required for a Custom Domain; `workers.dev` until then).

### 3.3 Cost
$0/mo at 0 installs (workers.dev; optional domain ~$10/yr). ~$0/mo at 100 installs on Workers Free **only if** the design targets hold (est. 55–70k requests/day incl. 1,440 alarm requests + 1,440 `setAlarm` row writes per hub per day, heartbeats answered by auto-response, ≤500 proxied RPC/install/day) and the other 22 Workers leave headroom — recommend $5/mo Paid anyway. ~$8–15/mo at 1,000 installs on Paid (Workers $5 + ~20M req/mo → +$3; DO ~0.5M req and <60k GB-s within included; D1/KV/AE within included), **excluding** upstream RPC/market provider fees (unverified, could dominate). Workers AI, if ever enabled: 10,000 Neurons/day account-wide free (llama-3.2-3b-instruct = 4,625 Neurons/M input, 30,475/M output → ~930 calls/day at 1,000-in/200-out, 300 rpm); 1,000 installs × 10 calls/day ≈ $32/mo overage on Paid. LoRA inference is open beta, "free during this period".

### 3.4 Honestly untestable today → labels
- Account plan and current daily request headroom: `UNVERIFIED (token lacks billing scope)` until U4(a).
- ratelimit binding "no charge": inferred from the absence of any pricing line (Workers pricing page, Aug 28 2026) plus the fact that `flyscout` on this account already runs four ratelimit bindings; report as "no known charge as of 2026-09-19", not a guarantee. It cannot implement daily quotas (10/60 s windows, per-colo, eventually consistent).
- Auto-responses not billed as DO requests and pending alarms not blocking hibernation: docs footnote 3 ("will not be charged") + workerd source support both; `UNVERIFIED (owed T-heartbeat / T-alarm)` until measured on staging.
- Cost model per install/day: `DESIGN-TARGET` until T-load; report measured request counts next to the targets.
- R2 payment-method gate: first-party documented (Billing policy; HackerOne 2170559) and live 403 code 10042 on this account; report `R2: NOT ENABLED (payment method required)`.
- Whether Workers AI LoRA inference is billed at base-model Neuron rates and whether beta pricing persists: `UNVERIFIED`; never advertise "free inference" without "10,000 Neurons/day account-wide" attached.
- Upstream RPC/market provider free tiers/key policies and Custom Domain (needs a zone): `UNVERIFIED`.
- D1 daily limits are hard-enforced since 2026-09-01: report D1 read/write consumption per phase; auth lookups fail until midnight UTC if exceeded.

---

## Corrections from verification (every refuted claim)

1. **Refuted — "Docker Desktop 4.91.0: `winget install` = all-users + UAC, and manual `install --user` truly needs no admin on this build."** Manifest facts stand (`Scope: machine`, `ElevationRequirement: elevatesSelf`, Custom `--accept-license --backend=wsl-2 --no-windows-containers`, build 239619), and a bare `winget install` is indeed an all-users install with the installer's own UAC prompt. But "no admin on this build" is overstated: WSL 2 is not enabled here, and Docker's own docs list "Enabling WSL 2 for the first time" under operations that always require elevation, so the per-user path costs exactly one UAC consent + one reboot first. Also, winget need not be abandoned: `winget install --id Docker.DockerDesktop -e --custom "--user"` (or `--override "install --user --quiet --accept-license --backend=wsl-2 --no-windows-containers"`) gives a per-user install; `--scope user` will be rejected (no user-scope installer, winget-pkgs #382764). Docker VMM (Beta) is a WSL-independent per-user backend but unverified on Home and still needs the Windows Hypervisor Platform feature (admin, one-time).
2. **Refuted — "Qwen3-4B-Instruct-2507 QLoRA on 6 GB: Unsloth publishes 3B=3.5 GB / 7B=5 GB, so ~4–4.5 GB interpolated."** Unsloth's table cannot be interpolated to Qwen3 (a Qwen 7B's 4-bit weights alone are 5.17 GiB, above the "7B = 5 GB" row; Qwen3 has a 151,936 vocab and Unsloth's dynamic quant keeps more layers in 16-bit). Unsloth auto-maps `Qwen/Qwen3-4B-Instruct-2507` + `load_in_4bit` to `unsloth/Qwen3-4B-Instruct-2507-unsloth-bnb-4bit` (3.30 GiB resident); the plain `-bnb-4bit` is 2.47 GiB. The only public measurement (Qwen3-4B, r=16, seq 2048, bs 2×GA 4, Unsloth GC, adamw_8bit, T4, short samples) peaked at 4.77 GiB reserved with the eval step at 6.36–6.46 GiB. Correct statement: "fit on 6 GB is UNMEASURED and expected marginal"; measure with sysmem fallback disabled (`set_per_process_memory_fraction(1.0, 0)` in WSL2 / "Prefer No Sysmem Fallback" natively), record `max_memory_reserved` and `nvidia-smi`, assert no "Switching to 16bit LoRA", start at seq 1024 with the explicit `-bnb-4bit` name.
3. **Refuted — "Native-Windows Unsloth works today with torch cu130 + triton-windows on Python 3.12 without WSL."** As of 2026-09-19 `unsloth 2026.9.7` and `unsloth_zoo 2026.9.6` declare `torch<2.13.0`, while the cu130 index serves torch 2.14.0; following Unsloth's unpinned Windows docs installs 2.14.0+cu130 and then pip downgrades to a **CPU-only** PyPI torch. Unpinned `triton-windows` resolves to 3.8.0.post28 (built for torch 2.14/2.15). Unsloth's own `install.ps1` pins torch 2.11 + `triton-windows<3.7`. Working recipe: `pip install --index-url https://download.pytorch.org/whl/cu130 "unsloth[cu130-torch2121]"` + `pip install -U "triton-windows<3.8"` + `bitsandbytes>=0.50.2`, or `irm https://unsloth.ai/install.ps1 | iex`; VS Build Tools are not required. The two true sub-claims stand: the Triton fork moved to triton-lang/triton-windows on 2026-02-18, and WSL 2 is fully supported on Windows 11 Home (Microsoft FAQ) using only the existing Windows NVIDIA driver — WSL2 is the lower-risk path.
4. **Refuted — "Kaggle: 30 GPU h/week, 12 h sessions, P100 16 GB / 2×T4, 20 GB disk, phone verification; numbers from third-party mirrors."** The P100 was retired on 2026-09-15 (Kaggle staff announcement 735239; P100 notebooks auto-switch to T4x2; L4 is competition-only). Current facts: **T4 x2 only** (2×16 GB, 4 vCPU, 29 GB RAM), 30 GPU-h/week floor "or sometimes higher" resetting Saturday 00:00 UTC, 12 h max per CPU/GPU session (9 h TPU), 20 GB persisted `/kaggle/working`, 20-minute interactive idle timeout per docs (use "Save & Run All"), phone verification confirmed by Kaggle staff replies (not the docs page), TPU v5e-8 additionally requires Persona identity verification since 2026-01-28. T4 has no bf16 → run fp16; pin one GPU. The numbers are obtainable first-party via `POST https://www.kaggle.com/api/i/cms.LegacyCmsService/GetPage {"slug":"docs/notebooks"}`; the docs page is stale about the P100.

**Material refinements to non-refuted claims (adopted above):**
- #41635 is not build-specific (reproduced on 26200.8037), unacknowledged by Microsoft, and its sibling #41527 was local misconfiguration; 26200.9457 is the OOB fix KB5129195 for a different Plan9 bug. Use `hcsdiag hostproperties processortopology` / Event 11008 as the cheap discriminator; MSI Repair does not address HCS failures.
- `wsl --update` is not the applicable command (WSL not installed); `wsl --install --no-distribution` lands on 2.7.14 today. 2.7.14 contains only one of the two #40488 fixes (#40625 via backport #41540, not the MSI-rollback #40524), it is preventive for future upgrades, and moot for a fresh install.
- `wsl --install` non-elevated: the elevated child runs `--install --no-distribution`, the distro install is skipped until after the reboot, the consent prompt is on the secure desktop and must be answered by the interactive user (never from an agent context); clicking No cancels.
- hypervisorlaunchtype: verified in effect via Hyper-V-Hypervisor Event ID 1 at every boot; #40344 is an early-boot hypervisor-init failure whose trigger cannot occur here.
- Docker Desktop on Home: "confirm with Docker support" is not actionable (no support channel for free users); wording fixed in §1.4.
- Ratelimit binding: already proven on this account (`flyscout`, namespace_ids 1001–1004) — the research's proposed ids 1001–1003 would collide and share counters; use 2001–2003 / 2101–2103.
- Hub DO cost: heartbeats are free; the 60 s alarm is the real cost (1,440 requests + 1,440 row writes per hub per day) — keep hubs few and re-arm only while sockets exist; the lifecycle page lists five hibernation blockers (add "no request/event still being processed").
- R2 payment gate is first-party documented (not only third-party guides) and accepts PayPal/Apple Pay/Google Pay/Link, not just a credit card.
- Workers AI: the 2025-04 changelog is stale as a LoRA base list; the authoritative list is the 9 LoRA-badged models; an adapter must be trained on Llama-3.2-3B-Instruct itself; Neuron rates 4,625/M in, 30,475/M out; 10,000 Neurons/day is account-wide.
- Gemma 4: Apache-2.0 confirmed, but there is no LICENSE file in the HF repo — cite README front matter + https://ai.google.dev/gemma/docs/gemma_4_license and pin sha `ee0ef6023621cff504d758262d4e04895a5af4a2`; the Gemma Terms/Prohibited Use Policy explicitly exclude Gemma 4.
- Qwen3.5 QLoRA "not recommended" is advisory (loads and trains), 10 GB bf16 LoRA figure stands; official 4B notebook is a FastVisionModel notebook — a text-only script must skip vision layers deliberately.
- Colab free: T4 is the only possible GPU and is not guaranteed; ~12–15 GPU-h/week per third-party measurements; ~90 min idle disconnect (unpublished); background execution is Pro+ only.

---

## Open questions for the user (max 5)

1. Confirm the public GitHub repo name/visibility `sighttrue/atra` (public is required for unlimited Actions minutes and is what Codespaces/CI assume).
2. Cloudflare: will you add a payment method to account 77debe4d… (enables R2 and Workers Paid $5/mo before launch), or stay strictly Free with HF Hub + GitHub Releases for artifacts? Also, can you read the current daily request usage of the 22 existing Workers in the dashboard?
3. Accounts for training: do you have a phone-verified Kaggle account and a Hugging Face account/token, and is ~$1–2 per run on RunPod/Vast (card on file) acceptable as the paid fallback?
4. If `wsl --install` shows the #41635 signature: are you willing to temporarily uninstall Riot Vanguard and run an elevated `bcdedit /enum {current}` check, and is proprietary Docker Desktop acceptable as a local fallback or do you want Apache-2.0-only (Rancher/Engine)?
5. Which RPC providers (Base/BSC/Robinhood Chain/Solana) and market-data provider do you already hold keys for, and have you created the two Telegram bots (production + staging) — or should the plan start with public RPC + BYOK only?