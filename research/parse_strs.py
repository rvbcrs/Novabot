import re

files = [
  "/Users/rvbcrs/GitHub/Novabot/research/blutter_output_v2.4.0/asm/flutter_novabot/pages/schedule/logic.dart",
  "/Users/rvbcrs/GitHub/Novabot/research/blutter_output_v2.4.0/asm/flutter_novabot/pages/home_page/view/mower_status/online_view.dart"
]

for fpath in files:
    try:
        with open(fpath, "r", encoding="utf-8") as f:
            text = f.read()
        strs = set()
        for ln in text.split('\n'):
            matches = re.findall(r'"([^"]+)"', ln)
            for m in matches:
                strs.add(m)
        
        print(f"=== {fpath.split('/')[-1]} ===")
        cleaned = [s for s in list(strs) if len(s)>3 and not s.startswith("package:") and not s.startswith("dart:")]
        print(" | ".join(cleaned)[:800])
    except Exception as e:
        print(e)
