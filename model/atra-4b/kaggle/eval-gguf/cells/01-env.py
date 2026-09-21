!nvidia-smi
import platform, subprocess, torch
print("torch", torch.__version__, "cuda", torch.version.cuda)
print("python", platform.python_version())
print(subprocess.run(
    ["nvidia-smi", "--query-gpu=name,compute_cap,memory.total", "--format=csv,noheader"],
    capture_output=True, text=True).stdout)
!ls -la /kaggle/input/*
!df -h
