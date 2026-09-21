%%bash
set +e
pkill -f llama-server
sleep 3
# The server log is useful but not an artifact; keep only its tail.
tail -c 400000 /kaggle/working/llama-server.log > /kaggle/working/llama-server.tail.log 2>/dev/null
rm -f /kaggle/working/llama-server.log
rm -rf /kaggle/working/runs /kaggle/working/atra/data/out/train.jsonl
ls -la /kaggle/working
du -sh /kaggle/working
echo "done"
