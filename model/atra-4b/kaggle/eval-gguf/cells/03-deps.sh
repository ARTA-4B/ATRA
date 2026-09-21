%%bash
set -e
set -o pipefail
pip install -q "transformers==4.57.6" "peft==0.19.1" "accelerate==1.12.0" \
  "huggingface_hub==0.36.2" "sentencepiece==0.2.1" "pyyaml==6.0.3"
# Kaggle ships torchao 0.10.0. peft's LoRA dispatcher calls
# is_torchao_available() for every module it injects, and that helper raises
# on a version below 0.16.0 rather than returning False. The merge loads the
# base in fp16, so it reaches that dispatcher. Neither path uses torchao.
pip uninstall -q -y torchao || true
python - <<'PY'
import importlib.util
print("torchao present:", importlib.util.find_spec("torchao") is not None)
import accelerate, jinja2, peft, transformers, yaml
print("deps ok:", transformers.__version__, peft.__version__, accelerate.__version__)
print("jinja2 :", jinja2.__version__)
PY
