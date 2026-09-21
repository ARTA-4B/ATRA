import hashlib, json, os, pathlib, subprocess, time, urllib.request

BIN = '/kaggle/temp/llama.cpp/build/bin/llama-server'
GGUF_PATH = '/kaggle/working/atra-4b-q4_k_m.gguf'
PORT = 8080
ENDPOINT = f'http://127.0.0.1:{PORT}'
LOG = pathlib.Path('/kaggle/working/llama-server.log')
BUILD_KIND = pathlib.Path('/kaggle/temp/build-kind.txt').read_text().strip()
print('build kind:', BUILD_KIND)

# No --chat-template-file this time, deliberately.
#
# The previous run had to hand llama-server a template on the command line
# because the GGUF carried none. That patched the measurement, not the
# artifact: anyone downloading the file would still have been served a default
# template with no tools block. This run serves the GGUF with nothing but
# --jinja, so the template being used is the one inside the file.
command = [
    BIN, '-m', GGUF_PATH,
    '--host', '127.0.0.1', '--port', str(PORT),
    '-c', '8192', '-ngl', '99', '--parallel', '1',
    '-t', str(os.cpu_count() or 4),
    '--jinja',
]
print('$', ' '.join(command))
handle = LOG.open('ab')
server = subprocess.Popen(command, stdout=handle, stderr=subprocess.STDOUT)


def wait_ready(timeout=1200):
    deadline = time.time() + timeout
    while time.time() < deadline:
        if server.poll() is not None:
            print('server exited with', server.returncode)
            return False
        try:
            with urllib.request.urlopen(ENDPOINT + '/health', timeout=5) as response:
                if response.status == 200:
                    return True
        except Exception:
            pass
        time.sleep(3)
    return False


ready = wait_ready()
if not ready:
    print(LOG.read_text(errors='replace')[-6000:])
assert ready, 'llama-server never answered /health while serving the GGUF with --jinja alone'
print('server ready')

# What template is the server actually using? Its own answer, compared with
# the bytes read out of the GGUF two cells ago.
with urllib.request.urlopen(ENDPOINT + '/props', timeout=30) as response:
    props = json.loads(response.read())
served = props.get('chat_template') or (props.get('default_generation_settings') or {}).get('chat_template')
print()
print('/props keys        :', sorted(props.keys()))
if served:
    print('served template    :', len(served), 'chars')
    print('served sha256      :', hashlib.sha256(served.encode('utf-8')).hexdigest())
    print('GGUF sha256        :', GGUF_TEMPLATE_SHA)
    print('same as the GGUF   :', hashlib.sha256(served.encode('utf-8')).hexdigest() == GGUF_TEMPLATE_SHA)
    print('honours tools      :', '<tools>' in served or 'tools' in served)
else:
    print('/props does not report a chat template on this build; the prompt-token '
          'counts below are the evidence instead')
print()
print(json.dumps({k: v for k, v in props.items() if k != 'chat_template'}, indent=1)[:1500])
print()
print(LOG.read_text(errors='replace')[-1800:])
