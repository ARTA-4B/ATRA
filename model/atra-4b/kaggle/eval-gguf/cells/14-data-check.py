import collections, hashlib, json, pathlib

# The test split rebuilt in-kernel has to be the same 95 examples the working
# tree holds, or "against the repo's thresholds" means nothing. The expected
# digest is the working tree's data/out/test.jsonl at notebook generation time.
EXPECTED_TEST_SHA = "#@TESTSHA@#"

TEST = pathlib.Path('/kaggle/working/atra/data/out/test.jsonl')
raw = TEST.read_bytes()
digest = hashlib.sha256(raw).hexdigest()
print('test.jsonl in-kernel   :', digest)
print('test.jsonl working tree:', EXPECTED_TEST_SHA)
print('identical              :', digest == EXPECTED_TEST_SHA)
assert digest == EXPECTED_TEST_SHA, (
    'the deterministic rebuild does not reproduce the working tree split; '
    'the thresholds and the examples are no longer the same pair'
)

examples = [json.loads(line) for line in raw.decode('utf-8').splitlines() if line.strip()]
print()
print('examples   :', len(examples))
print('by domain  :', dict(collections.Counter(e['domain'] for e in examples)))
print('with tools :', sum(1 for e in examples if e.get('tools')))
