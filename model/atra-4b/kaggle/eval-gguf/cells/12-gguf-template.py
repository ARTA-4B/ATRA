import hashlib, json, pathlib

# The template inside the artifact, read out of the artifact.
#
# Everything so far is about the adapter and the exporter. This cell opens the
# q4_k_m file itself and asks what chat template it carries, because that is
# the only copy llama-server will have once the GGUF is all anyone has. The
# previous export carried none, and nothing downstream said a word.
GGUF = pathlib.Path('/kaggle/working/atra-4b-q4_k_m.gguf')
GGUF_SHA = hashlib.sha256()
with GGUF.open('rb') as handle:
    for chunk in iter(lambda: handle.read(1 << 22), b''):
        GGUF_SHA.update(chunk)
GGUF_SHA = GGUF_SHA.hexdigest()
GGUF_BYTES = GGUF.stat().st_size
print('gguf        :', GGUF)
print('gguf sha256 :', GGUF_SHA)
print('gguf bytes  :', GGUF_BYTES, f'({GGUF_BYTES / (1024 ** 3):.3f} GiB)')

from gguf import GGUFReader

reader = GGUFReader(str(GGUF))


def field_str(field):
    try:
        value = field.contents()
        if isinstance(value, str):
            return value
        if isinstance(value, bytes):
            return value.decode('utf-8')
    except Exception:
        pass
    return bytes(field.parts[field.data[-1]]).decode('utf-8')


keys = sorted(reader.fields.keys())
print()
print('gguf metadata keys carrying a template:',
      [k for k in keys if 'template' in k.lower()])

field = reader.fields.get('tokenizer.chat_template')
assert field is not None, (
    'the GGUF carries NO tokenizer.chat_template key. That is the finding: '
    'the exported artifact still cannot be served the way it was trained.'
)
GGUF_TEMPLATE = field_str(field)
GGUF_TEMPLATE_SHA = hashlib.sha256(GGUF_TEMPLATE.encode('utf-8')).hexdigest()
print()
print('GGUF chat template chars :', len(GGUF_TEMPLATE))
print('GGUF chat template sha256:', GGUF_TEMPLATE_SHA)
print('adapter template sha256  :', ADAPTER_TEMPLATE_SHA)
print('identical to the adapter :', GGUF_TEMPLATE_SHA == ADAPTER_TEMPLATE_SHA)

# Does the template *in the file* produce a tools block? Rendered here, before
# the server is started, from the bytes that will be shipped.
import copy

from transformers import AutoTokenizer

probe_tokenizer = AutoTokenizer.from_pretrained('/kaggle/working/runs/atra-4b')
probe_tokenizer.chat_template = GGUF_TEMPLATE

messages = [
    {'role': 'system', 'content': 'system prompt'},
    {'role': 'user', 'content': 'user turn'},
]
tools = [
    {
        'type': 'function',
        'function': {
            'name': 'get_market_snapshot',
            'description': 'Current price, liquidity and volume for a pool.',
            'parameters': {'type': 'object', 'required': ['chain'], 'properties': {'chain': {'type': 'string'}}},
        },
    }
]
plain = probe_tokenizer.apply_chat_template(messages, tokenize=False, add_generation_prompt=True)
with_tools = probe_tokenizer.apply_chat_template(
    messages, tools=tools, tokenize=False, add_generation_prompt=True
)
print()
print('rendered by the GGUF template, without tools:', len(plain), 'chars')
print('rendered by the GGUF template, with tools   :', len(with_tools), 'chars')
print('<tools> block present                       :', '<tools>' in with_tools)
print('tool name present                           :', 'get_market_snapshot' in with_tools)
assert 'get_market_snapshot' not in plain
assert 'get_market_snapshot' in with_tools, (
    'the template inside the GGUF ignores `tools`; serving it would repeat the '
    'first failure'
)
print()
print(with_tools[: len(with_tools) - len(plain) + 240])

pathlib.Path('/kaggle/working/gguf-chat-template.jinja').write_text(GGUF_TEMPLATE, encoding='utf-8')
del reader
