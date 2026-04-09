import os, re

asm_dir = "/Users/rvbcrs/GitHub/Novabot/research/blutter_output_v2.4.0/asm/flutter_novabot"
with open("commands_final.txt", "w") as out:
    for root, _, files in os.walk(asm_dir):
        for f in files:
            if f.endswith(".dart"):
                filepath = os.path.join(root, f)
                with open(filepath, "r", encoding="utf-8") as file:
                    for line in file:
                        m = re.search(r'r\d+\w* = "([^"]+)"', line)
                        if m:
                            out.write(f"{f}: {m.group(1)}\n")
