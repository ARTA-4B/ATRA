%%bash
# Deliberately no `set -e`: evaluate.py exits non-zero when a threshold is
# missed (1) or when the serving path ate the replies (3), and both are
# results to report rather than kernel failures.
set -o pipefail
cd /kaggle/working/atra

stat -c %s /kaggle/working/llama-server.log > /kaggle/working/log-offset-chat.txt

echo "################################################################"
echo "# PASS A  --serving chat"
echo "#   POST /v1/chat/completions with the tools; llama-server renders"
echo "#   the GGUF's own template and runs its tool-call parser. This is"
echo "#   how the ATRA runtime and Ollama talk to the model."
echo "################################################################"
python evaluate.py \
  --data data/out/test.jsonl \
  --model http://127.0.0.1:8080 \
  --model-name atra-4b-v0 \
  --serving chat \
  --tokenizer /kaggle/working/runs/atra-4b \
  --trace /kaggle/working/trace-chat.jsonl \
  --out /kaggle/working/eval-chat.json \
  --config config/default.yaml 2>&1 | tee /kaggle/working/evaluate-chat-stdout.txt
CHAT=${PIPESTATUS[0]}
echo "${CHAT}" > /kaggle/working/evaluate-chat-exit-code.txt
echo
echo "evaluate.py --serving chat exit code: ${CHAT}"

stat -c %s /kaggle/working/llama-server.log > /kaggle/working/log-offset-raw.txt

echo
echo "################################################################"
echo "# PASS B  --serving raw   (evaluate.py's default)"
echo "#   POST /completion with the prompt rendered here by"
echo "#   prompting.render_example — the same function train.py used."
echo "#   Nothing renders server-side, nothing parses the reply."
echo "################################################################"
python evaluate.py \
  --data data/out/test.jsonl \
  --model http://127.0.0.1:8080 \
  --model-name atra-4b-v0 \
  --serving raw \
  --tokenizer /kaggle/working/runs/atra-4b \
  --trace /kaggle/working/trace-raw.jsonl \
  --out /kaggle/working/eval-raw.json \
  --config config/default.yaml 2>&1 | tee /kaggle/working/evaluate-raw-stdout.txt
RAW=${PIPESTATUS[0]}
echo "${RAW}" > /kaggle/working/evaluate-raw-exit-code.txt
echo
echo "evaluate.py --serving raw  exit code: ${RAW}"
echo
echo "exit codes: chat=${CHAT} raw=${RAW}   (0 pass, 1 threshold missed, 3 replies lost content)"
