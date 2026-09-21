import hashlib, os, pathlib

# Which path does export.py take?
#
# export.py loads `AutoTokenizer.from_pretrained(<adapter>)` and, only if that
# tokenizer has no chat template, falls back to recovering one from the base
# model — refusing outright if neither has one. The previous adapter had no
# `chat_template.jinja`, which is how the exported GGUF ended up with no
# template and llama-server fell back to a built-in default with no `tools`
# block. train.py now writes the template beside the weights.
#
# So: does the tokenizer built from THIS adapter already carry a template? If
# yes, the fallback is not taken and the template in the GGUF is the one the
# training run rendered its prompts with, byte for byte.
os.environ.setdefault('HF_HOME', '/kaggle/temp/hf')
pathlib.Path('/kaggle/temp/hf').mkdir(parents=True, exist_ok=True)

from transformers import AutoTokenizer

ADAPTER = pathlib.Path('/kaggle/working/runs/atra-4b')
adapter_tokenizer = AutoTokenizer.from_pretrained(str(ADAPTER))
adapter_template = getattr(adapter_tokenizer, 'chat_template', None)

print('AutoTokenizer.from_pretrained(adapter).chat_template is set:', bool(adapter_template))
assert adapter_template, (
    'the adapter tokenizer has no chat template, so export.py would take the '
    'base-model fallback; report that, it is the finding'
)
ADAPTER_TEMPLATE_SHA = hashlib.sha256(adapter_template.encode('utf-8')).hexdigest()
print('template chars :', len(adapter_template))
print('template sha256:', ADAPTER_TEMPLATE_SHA)
print('file sha256    :',
      hashlib.sha256((ADAPTER / 'chat_template.jinja').read_bytes()).hexdigest(),
      ' (chat_template.jinja on disk)')
print()
print('EXPORT PATH  : adapter carries its own template -> export.py should NOT print')
print('               "template   : recovered from ..." in the merge cell below.')

# Is it the same template the base model publishes? Same answer either way is
# fine; a difference would be worth knowing before the artifact is served.
BASE = manifest['base_model']
REVISION = manifest.get('base_revision')
base_tokenizer = AutoTokenizer.from_pretrained(BASE, revision=REVISION)
base_template = getattr(base_tokenizer, 'chat_template', None)
print()
print('base model     :', BASE, '@', REVISION)
print('base template  :', 'none' if not base_template else
      hashlib.sha256(base_template.encode('utf-8')).hexdigest())
print('identical      :', base_template == adapter_template)

# Does the adapter's template honour `tools`? Rendered both ways, in the same
# shape prompting.render_example builds, so the answer is arithmetic.
probe_messages = [
    {'role': 'system', 'content': 'system prompt'},
    {'role': 'user', 'content': 'user turn'},
]
probe_tools = [
    {
        'type': 'function',
        'function': {
            'name': 'get_market_snapshot',
            'description': 'Current price, liquidity and volume for a pool.',
            'parameters': {'type': 'object', 'required': ['chain'], 'properties': {'chain': {'type': 'string'}}},
        },
    }
]
plain = adapter_tokenizer.apply_chat_template(probe_messages, tokenize=False, add_generation_prompt=True)
with_tools = adapter_tokenizer.apply_chat_template(
    probe_messages, tools=probe_tools, tokenize=False, add_generation_prompt=True
)
print()
print('rendered without tools:', len(plain), 'chars')
print('rendered with tools   :', len(with_tools), 'chars')
print('tool name in rendering:', 'get_market_snapshot' in with_tools)
assert 'get_market_snapshot' not in plain
assert 'get_market_snapshot' in with_tools, 'this template ignores `tools`'
print()
print(with_tools[: len(with_tools) - len(plain) + 200])
