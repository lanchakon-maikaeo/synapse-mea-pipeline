# Thai word segmenter assets

`../thai-words.mjs` splits Thai text into words for search and source ranking. It is a JavaScript port of the
runtime of [OpenThai2.0-LATTE-WordSeg-Lite](https://huggingface.co/iapp/OpenThai2.0-LATTE-WordSeg-Lite)
0.1.2 (Hub commit d5f39bc) by OpenThai, iApp Technology Co., Ltd. and the LATTE authors, unit `short`.

| File | Source | Licence |
|---|---|---|
| `model.int8.onnx` | unchanged, SHA-256 `2f8d349528b3d8342f5cb9150a4e07e774f07e40e892367dbe18bd41ea1d29f3` | CC BY-SA 4.0 |
| `lexicon.txt.gz` | unchanged, SHA-256 `dc611971a797e105620ac2791311e8d9c1c5f0c2944527786a712ed5e2571d5a` | CC BY-SA 4.0 |
| `charids.json` | derived: `charclass.npz` plus the model's `vocab` metadata, run-length encoded by `scripts/thai-words-charids.py` | CC BY-SA 4.0 |
| `NOTICE`, `LICENSES/` | unchanged | — |

The port is derived from the Apache-2.0 runtime (`_runtime.py`). `charids.json` is shared under CC BY-SA 4.0
with the notice kept, as the model's licence requires.

On 2026-11-24 the port gave the same words as the Python runtime on 3,012 Thai lines from this repository.
`tests/thai-words.test.mjs` keeps a sample of those reference outputs.

To update: download the new release, check the SHA-256 values against its `manifest.json`, and regenerate
`charids.json` with `scripts/thai-words-charids.py <unpacked wheel> charids.json`. Then compare the port with
the Python runtime again before replacing the files.
