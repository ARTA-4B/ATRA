// Build a private, self-contained Kaggle job from an explicit source allowlist.
// Run from the repository root. No credentials or user data are bundled.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { resolve, join } from 'node:path';

const root = resolve('model/atra-4b');
const output = resolve('artifacts/atra-training-20260921/kernel');
mkdirSync(output, { recursive: true });
const names = ['train.py', 'evaluate.py', 'evaluate_adapter.py', 'config/default.yaml',
  'data/__init__.py', 'data/build.py', 'data/checks.py', 'data/schema.py',
  'tests/__init__.py', 'tests/test_pipeline.py', 'tests/test_training.py', 'pyproject.toml'];
const files = Object.fromEntries(names.map(name => {
  const data = readFileSync(join(root, name));
  return [name, { base64: data.toString('base64'), sha256: createHash('sha256').update(data).digest('hex') }];
}));
const commit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
const script = `# ATRA-4B continuation: fixed completion loss, unchanged scoring thresholds.
import os
os.environ['CUDA_VISIBLE_DEVICES'] = '0'
os.environ['ATRA_AMP'] = 'off'
os.environ['PYTHONUNBUFFERED'] = '1'
import base64, hashlib, json, pathlib, subprocess, sys, time

WORK = pathlib.Path('/kaggle/working')
SOURCE = WORK / 'source'
SOURCE.mkdir(exist_ok=True)
FILES = json.loads(${JSON.stringify(JSON.stringify(files))})
for name, entry in FILES.items():
    content = base64.b64decode(entry['base64'])
    assert hashlib.sha256(content).hexdigest() == entry['sha256']
    target = SOURCE / name
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_bytes(content)
(WORK / 'source-manifest.json').write_text(json.dumps({'parent_git_commit': '${commit}', 'files': {k: v['sha256'] for k,v in FILES.items()}}, indent=2))

def run(command, name, allowed=(0,)):
    print('RUN', name, flush=True)
    with (WORK / (name + '.log')).open('w') as log:
        process = subprocess.Popen(command, cwd=SOURCE, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, bufsize=1)
        for line in process.stdout:
            log.write(line)
            log.flush()
            print(line, end='', flush=True)
        code = process.wait()
    (WORK / (name + '.exit-code.txt')).write_text(str(code))
    if code not in allowed:
        raise RuntimeError(f'{name} exited {code}; see saved log')

run([sys.executable, '-m', 'pip', 'install', '-q', 'transformers==4.57.6', 'trl==0.27.0', 'peft==0.19.1', 'accelerate==1.12.0', 'bitsandbytes==0.50.2', 'datasets==4.5.0', 'sentencepiece==0.2.1', 'huggingface_hub==0.36.2', 'pyyaml==6.0.3', 'pytest==9.0.2'], 'dependencies')
run([sys.executable, '-m', 'pip', 'uninstall', '-y', 'torchao'], 'remove-unused-torchao')
import torch, yaml
assert torch.cuda.is_available(), 'GPU required; refusing CPU training'
print('GPU:', torch.cuda.get_device_name(0), 'torch:', torch.__version__, flush=True)
run([sys.executable, '-m', 'pytest', 'tests', '-q'], 'tests')
run([sys.executable, '-m', 'data.build', '--seed', '42', '--per-domain', '200', '--out', 'data/out'], 'dataset-build')
run([sys.executable, '-m', 'data.checks', 'data/out'], 'dataset-check')

adapters = [p.parent for p in pathlib.Path('/kaggle/input').rglob('adapter_model.safetensors')]
assert len(adapters) == 1, f'expected one parent adapter, got {adapters}'
adapter = adapters[0]
parent = json.loads((adapter / 'manifest.json').read_text())
assert parent['status'] == 'completed' and parent['steps'] == 200
sys.path.insert(0, str(SOURCE))
from train import load_dataset
from data.checks import dataset_hash
train, validation, counts = load_dataset(SOURCE / 'data/out')
assert dataset_hash(train + validation) == parent['dataset_hash'], 'parent dataset mismatch'
config = yaml.safe_load((SOURCE / 'config/default.yaml').read_text())
config['run']['name'] = 'atra-4b-continuation-20260921'
config['run']['notes'] = 'Continue completed 200-step adapter; four additional epochs; completion-only loss verified; select best validation loss; one final test evaluation; unchanged thresholds.'
config['training']['epochs'] = 4
config['training']['learning_rate'] = 0.0001
config['model']['revision'] = parent['base_revision']
(SOURCE / 'config/continuation.yaml').write_text(yaml.safe_dump(config, sort_keys=False))
(WORK / 'run-plan.json').write_text(json.dumps({'parent_manifest': parent, 'parent_adapter_sha256': hashlib.sha256((adapter / 'adapter_model.safetensors').read_bytes()).hexdigest(), 'config': config, 'planned_additional_steps': 400, 'selection': 'lowest validation loss', 'test_policy': 'one final evaluation; never used for selection'}, indent=2))

# Baseline uses validation only. Raw output bypasses native tool-call parsing.
run([sys.executable, 'evaluate_adapter.py', '--adapter', str(adapter), '--data', 'data/out/validation.jsonl', '--out', str(WORK / 'baseline-validation.json')], 'baseline-validation', allowed=(0,1))
destination = WORK / 'adapter'
run([sys.executable, 'train.py', '--adapter', str(adapter), '--config', 'config/continuation.yaml', '--output', str(destination)], 'train')
run([sys.executable, 'evaluate_adapter.py', '--adapter', str(destination), '--data', 'data/out/validation.jsonl', '--out', str(WORK / 'final-validation.json')], 'final-validation', allowed=(0,1))
run([sys.executable, 'evaluate_adapter.py', '--adapter', str(destination), '--data', 'data/out/test.jsonl', '--out', str(WORK / 'final-test.json')], 'final-test', allowed=(0,1))
report = json.loads((WORK / 'final-test.json').read_text())
(WORK / 'result.json').write_text(json.dumps({'training': 'completed', 'evaluation': 'passed' if all(m['meets_threshold'] for m in report['metrics']) else 'failed', 'deployment_validated': False, 'finished_at': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())}, indent=2))
print((WORK / 'result.json').read_text(), flush=True)
`;
writeFileSync(join(output, 'train-continuation.py'), script);
writeFileSync(join(output, 'kernel-metadata.json'), JSON.stringify({
  id: 'atra12/atra-4b-continuation-20260921', title: 'ATRA-4B continuation 20260921',
  code_file: 'train-continuation.py', language: 'python', kernel_type: 'script',
  is_private: 'true', enable_gpu: 'true', enable_tpu: 'false', enable_internet: 'true',
  machine_shape: 'NvidiaTeslaT4', dataset_sources: ['atra12/atra-4b-adapter-v0'],
  competition_sources: [], kernel_sources: [], model_sources: [],
}, null, 2));
console.log(output);
