import base64, hashlib, pathlib, shutil

# The ATRA repository files this evaluation needs, carried verbatim as base64.
# Carried rather than cloned so the run cannot silently evaluate a different
# revision of evaluate.py, prompting.py, data/build.py or config/default.yaml
# than the one whose thresholds this result will be reported against.
#
# The blobs are not hand-written: `make-notebook.js` reads each file from the
# working tree at generation time, so refreshing the notebook refreshes the
# harness. EXPECTED holds the digest of the file as it stood in the working
# tree when this notebook was generated, and the assertion below makes the
# comparison part of the run rather than a promise about it.
FILES = {
#@FILES@#
}

EXPECTED = {
#@EXPECTED@#
}

root = pathlib.Path('/kaggle/working/atra')
if root.exists():
    shutil.rmtree(root)

for name, blob in FILES.items():
    raw = base64.b64decode(blob)
    target = root / name
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_bytes(raw)
    digest = hashlib.sha256(raw).hexdigest()
    match = 'MATCHES working tree' if digest == EXPECTED[name] else 'DIFFERS <-- STOP'
    print(f"{digest}  {name}  ({len(raw)} bytes)  {match}")

bad = [
    name
    for name, blob in FILES.items()
    if hashlib.sha256(base64.b64decode(blob)).hexdigest() != EXPECTED[name]
]
assert not bad, f'carried files do not match the working tree: {bad}'

print()
print(sorted(str(p.relative_to(root)) for p in root.rglob('*') if p.is_file()))
print()
print('--- evaluation thresholds this run is judged against ---')
print((root / 'config/default.yaml').read_text().split('evaluation:')[-1])
