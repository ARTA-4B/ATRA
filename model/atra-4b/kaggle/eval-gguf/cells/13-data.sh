%%bash
set -e
set -o pipefail
cd /kaggle/working/atra
# The same command, seed and per-domain count the thresholds were written for.
python -m data.build --seed 42 --per-domain 200 --out data/out
python -m data.checks data/out > /kaggle/working/data-checks.txt 2>&1 || true
tail -3 /kaggle/working/data-checks.txt
echo
wc -l data/out/*.jsonl
echo
echo "=== the 95 examples this run is scored on ==="
sha256sum data/out/test.jsonl data/out/validation.jsonl data/out/train.jsonl
