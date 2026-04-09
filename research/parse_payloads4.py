import os, re

asm_dir = "/Users/rvbcrs/GitHub/Novabot/research/blutter_output_v2.4.0/asm/flutter_novabot"

# Find all string assignments
# Keep track of file, line_num, string_value

commands_found = []

for root, _, files in os.walk(asm_dir):
    for fn in files:
        if fn.endswith(".dart"):
            filepath = os.path.join(root, fn)
            with open(filepath, "r", encoding="utf-8") as f:
                content = f.read()
                
            # Find all strings with line index
            lines = content.split('\n')
            strings_in_file = []
            for i, line in enumerate(lines):
                m = re.search(r'r\d+\w* = "([^"]+)"', line)
                if m:
                    s = m.group(1)
                    if " " not in s and len(s) > 1 and s not in ["OK", "Cancel", "GET", "POST"]:
                        strings_in_file.append((i, s))
            
            # Find elements that contain "cmd_num" or end with "_respond"
            for k, (line_idx, text) in enumerate(strings_in_file):
                if text == "cmd_num" or text == "topic" or text.endswith("_respond") or text.startswith("start_") or text.startswith("add_") or text == "auto_recharge" or text == "go_to_charge":
                    # Grab surrounding strings
                    start = max(0, k - 40)
                    end = min(len(strings_in_file), k + 20)
                    
                    cluster = []
                    for j in range(start, end):
                        # only include if they are somewhat close in lines (within 200 lines)
                        if abs(strings_in_file[j][0] - line_idx) < 300:
                            s = strings_in_file[j][1]
                            # skip common dart types or random stuff
                            if s not in ["null", "true", "false", "type", "cmd_num", "topic"]:
                                if s not in cluster:
                                    cluster.append(s)
                    
                    # Store as unique tuple
                    if len(cluster) > 0:
                        cmd_info = {
                            "file": fn,
                            "line": line_idx,
                            "trigger": text,
                            "cluster": cluster
                        }
                        commands_found.append(cmd_info)

# De-duplicate identical clusters
unique_clusters = []
seen_clusters = set()

for c in commands_found:
    tup = tuple(c["cluster"])
    if tup not in seen_clusters:
        seen_clusters.add(tup)
        unique_clusters.append(c)

for c in unique_clusters:
    # try to identify the main command in the cluster. It's usually snake_case and the first or second thing
    print(f"--- File: {c['file']}, Line: {c['line']}, Trigger: {c['trigger']} ---")
    print(f"Payload Keys / Associated strings: {c['cluster']}")
    print("")

