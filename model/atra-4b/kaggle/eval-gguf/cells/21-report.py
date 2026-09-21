import json, pathlib

EXIT_MEANING = {
    '0': 'PASS — every threshold met',
    '1': 'FAIL — at least one metric below threshold',
    '2': 'ERROR — the harness could not run',
    '3': 'CONTAMINATED — replies lost content between the model and the scorer',
}


def report(title, eval_path, code_path):
    path = pathlib.Path(eval_path)
    if not path.exists():
        print(title, '-> no eval.json; this pass did not finish')
        return None
    data = json.loads(path.read_text(encoding='utf-8'))
    code = pathlib.Path(code_path).read_text().strip()

    print('=' * 104)
    print(title)
    print('=' * 104)
    print('model        :', data['model'])
    print('backend      :', data.get('backend'))
    print('dataset hash :', data['dataset_hash'])
    print('examples     :', data['examples'])
    print('ran at       :', data['ran_at'], f"({data['duration_sec']}s)")
    print('gguf sha256  :', GGUF_SHA)
    print('gguf bytes   :', GGUF_BYTES)
    print()

    header = (f"{'metric':<30}{'score':>9}{'threshold':>12}{'direction':>17}"
              f"{'passed':>12}{'verdict':>10}{'margin':>12}")
    print(header)
    print('-' * len(header))
    missed = []
    for metric in data['metrics']:
        threshold = metric['threshold']
        lower = metric['lower_is_better']
        direction = 'lower is better' if lower else 'higher is better'
        fraction = f"{metric['passed']}/{metric['total']}"
        if threshold is None:
            verdict, margin, shown = 'n/a', '', 'n/a'
        else:
            ok = metric['meets_threshold']
            verdict = 'PASS' if ok else 'FAIL'
            delta = (threshold - metric['score']) if lower else (metric['score'] - threshold)
            margin = f'{delta:+.4f}'
            shown = f'{threshold:.4f}'
            if not ok:
                missed.append((metric['name'], metric['score'], threshold, delta, lower))
        print(f"{metric['name']:<30}{metric['score']:>9.4f}{shown:>12}{direction:>17}"
              f"{fraction:>12}{verdict:>10}{margin:>12}")

    print()
    if missed:
        print(f'{len(missed)} metric(s) BELOW THRESHOLD:')
        for name, score, threshold, delta, lower in missed:
            word = 'above the maximum by' if lower else 'short of the minimum by'
            print(f'  - {name}: {score:.4f} vs {threshold:.4f} ({word} {abs(delta):.4f})')
    else:
        print('every metric meets its threshold.')

    accounting = data.get('content_accounting') or {}
    print()
    print('content accounting')
    print('  replies                     :', accounting.get('replies'))
    print('  checked                     :', accounting.get('checked'))
    print('  generated tokens (server)   :', accounting.get('generated_tokens_total'))
    print('  tokens in the returned text :', accounting.get('returned_tokens_total'))
    print('  empty replies               :', accounting.get('empty_replies'))
    print('  REPLIES_LOSING_CONTENT      :', accounting.get('replies_losing_content'))
    print('  prompt tokens, rendered here:',
          accounting.get('prompt_tokens_local_min'), '-', accounting.get('prompt_tokens_local_max'))
    print('  prompt tokens, per server   :',
          accounting.get('prompt_tokens_server_min'), '-', accounting.get('prompt_tokens_server_max'))
    print('  local/server disagreements  :', accounting.get('prompt_tokens_local_vs_server_mismatch'))
    for row in accounting.get('worst', []) or []:
        print(f"      {row['id']}: generated {row['generated_tokens']}, returned {row['returned_tokens']}")

    print()
    print('example ids that failed each metric (evaluate.py records the first ten):')
    for metric in data['metrics']:
        if metric['failures']:
            print(f"  {metric['name']}: {metric['failures']}")

    print()
    print('evaluate.py exit code:', code, '->', EXIT_MEANING.get(code, 'unknown'))
    print()
    return code, data


chat = report('PASS A — q4_k_m GGUF via llama-server /v1/chat/completions (tools sent, server renders and parses)',
              '/kaggle/working/eval-chat.json', '/kaggle/working/evaluate-chat-exit-code.txt')
raw = report('PASS B — q4_k_m GGUF via llama-server /completion (prompt rendered by prompting.render_example)',
             '/kaggle/working/eval-raw.json', '/kaggle/working/evaluate-raw-exit-code.txt')

print('=' * 104)
print('SUMMARY')
print('=' * 104)
print('gguf sha256 :', GGUF_SHA)
print('gguf bytes  :', GGUF_BYTES)
print('build kind  :', BUILD_KIND)
for name, result in (('chat', chat), ('raw', raw)):
    if result is None:
        print(f'{name:<5}: did not finish')
        continue
    code, data = result
    losing = (data.get('content_accounting') or {}).get('replies_losing_content')
    print(f'{name:<5}: exit {code} ({EXIT_MEANING.get(code, "unknown")}), '
          f'replies_losing_content={losing}')

print()
print('=' * 104)
print('raw eval-chat.json')
print('=' * 104)
print(pathlib.Path('/kaggle/working/eval-chat.json').read_text()
      if pathlib.Path('/kaggle/working/eval-chat.json').exists() else 'missing')
print()
print('=' * 104)
print('raw eval-raw.json')
print('=' * 104)
print(pathlib.Path('/kaggle/working/eval-raw.json').read_text()
      if pathlib.Path('/kaggle/working/eval-raw.json').exists() else 'missing')
