%%bash
set -e
set -o pipefail
# Keep the 8 GiB base download, the merged fp16 weights and the f16 GGUF
# intermediate off the 20 GiB /kaggle/working quota; only the q4_k_m file and
# its manifest are worth saving as output.
export HF_HOME=/kaggle/temp/hf
mkdir -p /kaggle/temp/hf
cd /kaggle/working/atra
python export.py --adapter /kaggle/working/runs/atra-4b --out /kaggle/temp/atra-export \
  --llama-cpp /kaggle/temp/llama.cpp --gguf q4_k_m > /kaggle/working/export.log 2>&1
tail -25 /kaggle/working/export.log

echo
echo "=== which template path did export.py take? ==="
if grep -q "template   : recovered from" /kaggle/working/export.log; then
  echo "FALLBACK: export.py recovered the template from the base model"
  grep "template   : recovered from" /kaggle/working/export.log
else
  echo "ADAPTER: no 'recovered from' line -> the adapter's own chat_template.jinja was used"
fi
grep -E "^(base model|adapter|dtype|merged|template)" /kaggle/working/export.log || true

echo
ls -la /kaggle/temp/atra-export
cp /kaggle/temp/atra-export/atra-4b-q4_k_m.gguf /kaggle/working/
cp /kaggle/temp/atra-export/Modelfile /kaggle/working/
cp /kaggle/temp/atra-export/export-manifest.json /kaggle/working/
rm -rf /kaggle/temp/atra-export/merged
echo
echo "=== the artifact ==="
sha256sum /kaggle/working/atra-4b-q4_k_m.gguf
stat -c '%s bytes' /kaggle/working/atra-4b-q4_k_m.gguf
cat /kaggle/working/export-manifest.json
df -h /kaggle/working
