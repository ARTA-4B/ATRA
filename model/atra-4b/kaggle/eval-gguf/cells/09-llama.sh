%%bash
set -e
set -o pipefail
# /kaggle/temp does not exist unless a notebook creates it.
mkdir -p /kaggle/temp
cd /kaggle/temp
rm -rf llama.cpp
git clone --depth 1 https://github.com/ggml-org/llama.cpp.git
cd llama.cpp
echo "llama.cpp commit: $(git rev-parse HEAD)"
# Only the converter's own package. llama.cpp's requirements file pins a CPU
# build of torch, which would replace Kaggle's CUDA torch.
pip install -q --no-deps gguf

BUILD=/kaggle/temp/llama.cpp/build
set +e
ARCH=$(nvidia-smi --query-gpu=compute_cap --format=csv,noheader 2>/dev/null | head -1 | tr -d '. ')
set -e
[ -z "${ARCH}" ] && ARCH=75
echo "cuda architecture: ${ARCH}"

# The CUDA build failed to configure on this image on the previous attempt:
# FindCUDAToolkit could not resolve CUDA::cuda_driver, because the driver
# library a container sees is libcuda.so.1 with no libcuda.so symlink and the
# toolkit's stub directory is not on the default link path. Both are pointed
# at explicitly here. It matters: the CPU server generates at ~5 tokens/s, so
# 95 prompts of a few hundred tokens each is hours rather than minutes.
echo "--- libcuda on this image ---"
ls -la /usr/local/cuda/lib64/stubs/libcuda.so 2>/dev/null || echo "no toolkit stub"
ls -la /usr/lib/x86_64-linux-gnu/libcuda.so* 2>/dev/null || echo "no driver lib"

DRIVER=""
for candidate in /usr/local/cuda/lib64/stubs/libcuda.so \
                 /usr/lib/x86_64-linux-gnu/libcuda.so \
                 /usr/lib/x86_64-linux-gnu/libcuda.so.1; do
  if [ -e "$candidate" ]; then DRIVER="$candidate"; break; fi
done
echo "driver library: ${DRIVER:-none found}"

CFG=1
BLD=1
if [ -n "$DRIVER" ]; then
  set +e
  cmake -S /kaggle/temp/llama.cpp -B "$BUILD" -DCMAKE_BUILD_TYPE=Release \
    -DGGML_CUDA=ON -DCMAKE_CUDA_ARCHITECTURES="${ARCH}" -DLLAMA_CURL=OFF \
    -DCMAKE_LIBRARY_PATH=/usr/local/cuda/lib64/stubs \
    -DCUDA_cuda_driver_LIBRARY="$DRIVER" \
    -DCUDA_CUDA_LIBRARY="$DRIVER" \
    > /kaggle/temp/cmake-configure.log 2>&1
  CFG=$?
  if [ $CFG -eq 0 ]; then
    cmake --build "$BUILD" --target llama-quantize llama-server -j"$(nproc)" \
      > /kaggle/temp/cmake-build.log 2>&1
    BLD=$?
  fi
  set -e
fi

if [ $CFG -ne 0 ] || [ $BLD -ne 0 ]; then
  echo "=== CUDA build failed (configure=$CFG build=$BLD); falling back to CPU ==="
  tail -20 /kaggle/temp/cmake-configure.log 2>/dev/null || true
  tail -20 /kaggle/temp/cmake-build.log 2>/dev/null || true
  rm -rf "$BUILD"
  cmake -S /kaggle/temp/llama.cpp -B "$BUILD" -DCMAKE_BUILD_TYPE=Release \
    -DGGML_CUDA=OFF -DLLAMA_CURL=OFF > /kaggle/temp/cmake-configure-cpu.log 2>&1
  cmake --build "$BUILD" --target llama-quantize llama-server -j"$(nproc)" \
    > /kaggle/temp/cmake-build-cpu.log 2>&1
  echo CPU > /kaggle/temp/build-kind.txt
else
  echo CUDA > /kaggle/temp/build-kind.txt
fi

echo "build kind: $(cat /kaggle/temp/build-kind.txt)"
ls -la "$BUILD/bin" | grep -E "llama-quantize|llama-server"

echo
echo "--- llama-server chat template flags ---"
"$BUILD/bin/llama-server" --help 2>&1 | grep -E -- "--jinja|--chat-template-file" \
  || echo "WARNING: this build has neither --jinja nor --chat-template-file"
