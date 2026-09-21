import json, pathlib, sys, time, urllib.request

sys.path.insert(0, '/kaggle/working/atra')

TEST = pathlib.Path('/kaggle/working/atra/data/out/test.jsonl')
examples = [json.loads(line) for line in TEST.read_text(encoding='utf-8').splitlines() if line.strip()]
print('test examples:', len(examples))


def tools_for(example):
    """The tool block, in the exact shape prompting.tool_schemas builds."""
    return [
        {
            'type': 'function',
            'function': {
                'name': tool['name'],
                'description': tool['description'],
                'parameters': tool['parameters'],
            },
        }
        for tool in example.get('tools', [])
    ]


def prompt_of(example):
    return [
        {'role': message['role'], 'content': message['content']}
        for message in example['messages'] if message['role'] != 'assistant'
    ]


def post(path, body, timeout=900):
    request = urllib.request.Request(
        ENDPOINT + path,
        data=json.dumps(body).encode('utf-8'),
        headers={'content-type': 'application/json'},
    )
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return json.loads(response.read())


def ask_chat(messages, tools=None):
    body = {
        'model': 'atra-4b-v0',
        'messages': messages,
        'temperature': 0.0,
        'max_tokens': 512,
        'stream': False,
    }
    if tools:
        body['tools'] = tools
    return post('/v1/chat/completions', body)


# ---------------------------------------------------------------------------
# 1. Does the tool block reach the model through the server's own template?
#
# 91 prompt tokens with and without `tools` was the signature of the second
# failure: evaluate.py sent the schemas and llama-server dropped them, because
# the GGUF had no template. Same request, both ways, before ~95 generations.
# ---------------------------------------------------------------------------
tool_example = next(e for e in examples if e['domain'] == 'tool_use')
with_tools = ask_chat(prompt_of(tool_example), tools_for(tool_example))
without_tools = ask_chat(prompt_of(tool_example), None)

n_with = with_tools.get('usage', {}).get('prompt_tokens')
n_without = without_tools.get('usage', {}).get('prompt_tokens')
message = with_tools['choices'][0]['message']

print('=' * 78)
print('PROMPT SHAPE CHECK  (example:', tool_example['id'], ')')
print('  prompt_tokens WITHOUT tools :', n_without, '  <- what the first, broken run sent')
print('  prompt_tokens WITH tools    :', n_with, '  <- what the fixed harness sends')
print('  difference                  :', (n_with - n_without) if (n_with and n_without) else '?')
print('  tools in the example        :', [t['name'] for t in tool_example.get('tools', [])])
print('  reply message keys          :', sorted(message.keys()))
print('  content is empty            :', not (message.get('content') or '').strip())
print('  tool_calls present          :', bool(message.get('tool_calls')))
print('  finish_reason               :', with_tools['choices'][0].get('finish_reason'))
print('  raw message                 :', json.dumps(message, sort_keys=True)[:1200])
print('=' * 78)

assert n_with and n_without and n_with > n_without, (
    f'the tool block did not change the prompt length ({n_without} -> {n_with}); '
    'the server is not rendering tools and the run would repeat the original bug'
)
# Not an assertion any more. evaluate.py now rebuilds the reply from
# `tool_calls` when llama.cpp's parser moves it there, and records that it did
# so in the trace. Whether the parser fires is reported, not fatal.
if not (message.get('content') or '').strip() and message.get('tool_calls'):
    print()
    print("NOTE: llama.cpp's tool-call parser moved this reply out of content and")
    print('      into tool_calls. evaluate.py reconstructs ATRA\'s reply shape from')
    print('      it (EndpointModel._from_tool_calls) and flags each such reply in')
    print('      the trace as reconstructed_from_tool_calls.')

# ---------------------------------------------------------------------------
# 2. The other serving path on the same server: /completion with the prompt
#    rendered here by prompting.render_example — the same function train.py
#    used. Nothing renders, nothing parses. This is evaluate.py's default.
# ---------------------------------------------------------------------------
from data.checks import load_jsonl
from evaluate import load_tokenizer
from prompting import render_example

tokenizer = load_tokenizer('/kaggle/working/runs/atra-4b')
sample = next(e for e in load_jsonl(TEST) if e.id == tool_example['id'])

rendered = render_example(sample, tokenizer, prompt_only=True)
local_tokens = len(tokenizer(rendered, add_special_tokens=False)['input_ids'])
raw = post('/completion', {
    'prompt': rendered,
    'temperature': 0.0,
    'top_k': 1,
    'n_predict': 512,
    'cache_prompt': True,
    'stream': False,
    'stop': ['<|im_end|>', '<|endoftext|>'],
})
print()
print('=' * 78)
print('RAW /completion CHECK  (prompt rendered here, by the training template)')
print('  prompt chars                :', len(rendered))
print('  prompt tokens, rendered here:', local_tokens)
print('  prompt tokens, per server   :', raw.get('tokens_evaluated'))
print('  <tools> in the prompt       :', '<tools>' in rendered)
print('  tokens generated            :', raw.get('tokens_predicted'))
print('  stop type                   :', raw.get('stop_type'))
print('  reply                       :', (raw.get('content') or '')[:900])
print('=' * 78)

# ---------------------------------------------------------------------------
# 3. One example per domain, printed in full next to the expected answer. If a
#    metric fails later, this is the evidence for why.
# ---------------------------------------------------------------------------
seen = set()
probes = []
for example in examples:
    if example['domain'] not in seen:
        seen.add(example['domain'])
        probes.append(example)

for example in probes:
    started = time.time()
    body = ask_chat(prompt_of(example), tools_for(example))
    elapsed = time.time() - started
    reply = body['choices'][0]['message']
    print('=' * 78)
    print('id       :', example['id'], '| domain:', example['domain'], '| tags:', example.get('tags'))
    print('user     :', prompt_of(example)[-1]['content'][:300])
    print('expected :', json.dumps(example['expected_output'], sort_keys=True)[:400])
    print('reply    :', (reply.get('content') or '')[:900])
    if reply.get('tool_calls'):
        print('tool_call:', json.dumps(reply['tool_calls'], sort_keys=True)[:600])
    print(f'timing   : {elapsed:.1f}s  usage={body.get("usage", {})}')
