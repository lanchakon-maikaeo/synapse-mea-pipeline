# Writes app/api/chat/thai-words/charids.json for the JS port of OpenThai2.0-LATTE-WordSeg-Lite:
# the charclass.npz buckets with the model vocab ids laid over them, run-length encoded (CC BY-SA 4.0).
# Usage: python -I scripts/thai-words-charids.py <unpacked wheel dir> <out.json>   (needs numpy and onnx)
import sys, json, numpy as np, onnx
A = sys.argv[1] + "/openthai_latte_wordseg_lite/assets/"
m = onnx.load(A + "model.int8.onnx")
meta = {p.key: p.value for p in m.metadata_props}
vocab = json.loads(meta["vocab"])
table = np.load(A + "charclass.npz")["classes"].astype(np.int16)
print("classes", table.shape, table.dtype, "min/max", table.min(), table.max(), "vocab", len(vocab), "levels", json.loads(meta["config"]).get("levels"))
table[np.fromiter(map(ord, vocab), np.int64, len(vocab))] = np.arange(13, 13 + len(vocab))
runs, start = [], 0
for i in range(1, len(table) + 1):
    if i == len(table) or table[i] != table[start]:
        runs.append([start, int(table[start])]); start = i
json.dump({"size": len(table), "runs": runs}, open(sys.argv[2], "w"), separators=(",", ":"))
print("runs", len(runs))
