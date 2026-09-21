import json, pathlib, re, statistics

# Direct evidence that the tool block reached the model on every scored
# request, not just on the probes — from two independent records: the trace
# evaluate.py wrote per reply, and llama-server's own log.
LOG = pathlib.Path('/kaggle/working/llama-server.log')
log_text = LOG.read_text(errors='replace')


def from_trace(path):
    rows = [json.loads(line) for line in pathlib.Path(path).read_text().splitlines() if line.strip()]
    return rows


def describe(name, rows):
    print('=' * 78)
    print(name)
    print('  replies                     :', len(rows))
    for key, label in (
        ('prompt_tokens_server', 'prompt tokens, per the server'),
        ('prompt_tokens_local', 'prompt tokens, rendered here'),
        ('generated_tokens', 'tokens generated'),
        ('returned_tokens', 'tokens in the returned text'),
    ):
        values = [r[key] for r in rows if r.get(key) is not None]
        if values:
            print(f'  {label:<28}: min {min(values)}  median {int(statistics.median(values))}  '
                  f'max {max(values)}  mean {statistics.fmean(values):.1f}')
        else:
            print(f'  {label:<28}: not recorded by this path')
    short = [r for r in rows if (r.get('prompt_tokens_server') or 0) and r['prompt_tokens_server'] < 200]
    print('  prompts under 200 tokens    :', len(short),
          '  <- the first, broken run sat at 91-119 on every request')
    empty = [r for r in rows if not r.get('reply_chars')]
    print('  empty replies               :', len(empty), [r['id'] for r in empty[:10]])
    rebuilt = [r for r in rows if r.get('reconstructed_from_tool_calls')]
    print('  rebuilt from tool_calls     :', len(rebuilt), [r['id'] for r in rebuilt[:10]])
    trunc = [r for r in rows if r.get('finish_reason') == 'length' or r.get('truncated')]
    print('  hit the 512-token ceiling   :', len(trunc), [r['id'] for r in trunc[:10]])
    lost = [
        r for r in rows
        if r.get('generated_tokens') is not None
        and r.get('returned_tokens') is not None
        and r['returned_tokens'] < r['generated_tokens'] - 2
    ]
    print('  REPLIES LOSING CONTENT      :', len(lost))
    for r in lost[:10]:
        print(f"      {r['id']}: server generated {r['generated_tokens']}, "
              f"text carries {r['returned_tokens']}")
    print()


for label, path in (
    ('PASS A  --serving chat  (/v1/chat/completions)', '/kaggle/working/trace-chat.jsonl'),
    ('PASS B  --serving raw   (/completion)', '/kaggle/working/trace-raw.jsonl'),
):
    if pathlib.Path(path).exists():
        describe(label, from_trace(path))
    else:
        print(label, '-> no trace written')

# llama-server's own record, split at the byte offset taken before each pass.
print('=' * 78)
print("llama-server's own prompt lengths")
offsets = {}
for key in ('chat', 'raw'):
    p = pathlib.Path(f'/kaggle/working/log-offset-{key}.txt')
    offsets[key] = int(p.read_text().strip()) if p.exists() else 0

for key, start, end in (
    ('PASS A chat', offsets['chat'], offsets['raw'] or len(log_text)),
    ('PASS B raw ', offsets['raw'], len(log_text)),
):
    segment = log_text[start:end]
    counts = [int(n) for n in re.findall(r'prompt eval time.*?/\s*(\d+)\s*tokens', segment)]
    if not counts:
        counts = [int(n) for n in re.findall(r'n_prompt_tokens\s*=\s*(\d+)', segment)]
    if counts:
        print(f'  {key}: {len(counts)} prompt evals, min {min(counts)}, '
              f'median {int(statistics.median(counts))}, max {max(counts)}')
    else:
        print(f'  {key}: no prompt-eval lines in this segment of the log')
