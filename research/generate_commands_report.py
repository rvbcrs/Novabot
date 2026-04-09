import os, re
from collections import defaultdict

asm_dir = "/Users/rvbcrs/GitHub/Novabot/research/blutter_output_v2.4.0/asm/flutter_novabot"

file_strings = defaultdict(list)

# Find all string assignments matching rXX = "word" or rX = "word"
for root, _, files in os.walk(asm_dir):
    for fn in files:
        if fn.endswith(".dart"):
            filepath = os.path.join(root, fn)
            with open(filepath, "r", encoding="utf-8") as f:
                content = f.read()
                
            lines = content.split('\n')
            for i, line in enumerate(lines):
                # match r0, r16, r2, etc. Also x16, etc.
                m = re.search(r'[rx]\d+\w* = "([a-zA-Z_][a-zA-Z0-9_]*)"', line)
                if m:
                    s = m.group(1)
                    if s not in ["null", "true", "false", "GET", "POST"]:
                        file_strings[fn].append((i, s))

with open("analysis_results.md", "w") as out:
    out.write("# Novabot App Commands Overview\n\n")
    out.write("This document provides a comprehensive overview of all command-related communications (subscribed, published) and their associate payloads extracted from the reverse engineered NovaBot App.\n\n")

    for fn, strings in file_strings.items():
        # group strings into blocks if they appear within 50 lines of each other
        clusters = []
        current_cluster = []
        last_line = -1000
        
        for line_num, s in strings:
            if line_num - last_line > 50:
                if current_cluster:
                    clusters.append(current_cluster)
                current_cluster = [(line_num, s)]
            else:
                current_cluster.append((line_num, s))
            last_line = line_num
            
        if current_cluster:
            clusters.append(current_cluster)
            
        # keep only clusters containing cmd_num, type, topic, or end with _respond
        valid_clusters = []
        for c in clusters:
            words = [x[1] for x in c]
            if "cmd_num" in words or "topic" in words or any(w.endswith("_respond") for w in words):
                unique_words = list(dict.fromkeys(words))
                valid_clusters.append(unique_words)
                
        if valid_clusters:
            out.write(f"## {fn}\n\n")
            for cl in valid_clusters:
                # heuristics to find command name
                cmd_names = [w for w in cl if not w.endswith("Controller") and w not in ["cmd_num", "type", "topic", "payload", "message", "result"]]
                cmd_display = cmd_names[0] if cmd_names else "Unknown Command"
                
                out.write(f"### `{cmd_display}`\n")
                out.write(f"- **Payload Fields**: {', '.join(cl)}\n\n")

print("Report generated.")
