import hashlib, json, pathlib, shutil

# A data source's layout inside /kaggle/input is not the folder that was
# uploaded, so the adapter is found by its files rather than by an assumed
# path. The continuation run also saved checkpoint-300/ and checkpoint-400/,
# and each of those carries its own adapter_config.json — so the directory is
# picked by the pair (adapter_config.json AND manifest.json), which only the
# final adapter has.
inputs = pathlib.Path('/kaggle/input')
print('inputs:', [str(p) for p in inputs.glob('*')])
candidates = [
    p.parent
    for p in inputs.rglob('adapter_config.json')
    if (p.parent / 'manifest.json').exists()
]
assert candidates, f'no adapter directory with a manifest under {inputs}'
assert len(candidates) == 1, f'ambiguous: {candidates}'
src = candidates[0]
print('adapter found at:', src)
print('adapter files  :', sorted(p.name for p in src.iterdir()))

dst = pathlib.Path('/kaggle/working/runs/atra-4b')
if dst.exists():
    shutil.rmtree(dst)
dst.parent.mkdir(parents=True, exist_ok=True)
dst.mkdir()
# Only the files the merge and the tokenizer need; the intermediate
# checkpoints are 126 MiB each and are not part of this artifact.
for item in sorted(src.iterdir()):
    if item.is_file():
        shutil.copy2(item, dst / item.name)

print()
print('staged        :', sorted(p.name for p in dst.iterdir()))
for name in ('adapter_model.safetensors', 'chat_template.jinja', 'adapter_config.json'):
    p = dst / name
    if p.exists():
        print(f'{hashlib.sha256(p.read_bytes()).hexdigest()}  {name}  ({p.stat().st_size} bytes)')
    else:
        print(f'{"MISSING":<64}  {name}')

TEMPLATE_IN_ADAPTER = (dst / 'chat_template.jinja').exists()
print()
print('adapter ships its own chat_template.jinja:', TEMPLATE_IN_ADAPTER,
      '  <- the old adapter did not, which is how the GGUF lost its template')

manifest = json.loads((dst / 'manifest.json').read_text())
print()
print('run name    :', manifest['run_name'])
print('status      :', manifest['status'])
print('steps       :', manifest['steps'])
print('parent steps:', manifest.get('parent_steps'))
print('final loss  :', round(manifest['final_loss'], 7))
print('base model  :', manifest['base_model'])
print('base rev    :', manifest.get('base_revision'))
print('gpu         :', manifest.get('gpu_name'))
print('dataset hash:', manifest['dataset_hash'])
print('counts      :', manifest['dataset_counts'])
assert manifest['status'] == 'completed'
assert manifest['steps'] == 400, manifest['steps']
