import re

with open("novabot_commands_overview.md", "r", encoding="utf-8") as f:
    text = f.read()

# We will rewrite the markdown.
# 1. Parse table rows
# 2. Build details sections

out = []

def make_json(cmd, fields, is_incoming):
    # try to deduce types
    data = {}
    if not is_incoming:
        if "cmd_num" in fields:
            data["cmd_num"] = 1234
        if "type" in fields or cmd not in ["get_map_list"]: # typically all have type
            data["type"] = cmd
            
        inner = {}
        for f in fields:
            if f in ["cmd_num", "type"]:
                continue
            if f in ["manual", "test", "reset_map", "init"]:
                inner[f] = True
            elif f in ["latitude", "longitude", "x", "y", "position", "dis"]:
                inner[f] = 0.0
            elif f in ["value", "cmd_num", "cutterhigh", "area", "map_ids", "cov_direction", "status", "wifi_rssi", "v"]:
                inner[f] = 1
            else:
                inner[f] = f"voorbeeld_{f}"
                
        if inner:
            data[cmd] = inner
            
    else:  # incoming
        data["type"] = cmd
        if "result" in fields:
            data["result"] = True
        if "message" in fields:
            data["message"] = "success"
            
        inner = {}
        for f in fields:
            if f in ["cmd_num", "type", "result", "message"]:
                continue
            if f == "success": inner[f] = True
            elif f in ["x", "y", "position", "wifi_rssi", "v", "value", "size", "md5"]:
                inner[f] = 123
            elif f in ["zip_dir_empty", "fail"]:
                inner[f] = False
            elif f == "version":
                inner[f] = "1.0.0"
            elif f == "data":
                inner[f] = {"path": []}
            elif f.endswith("_respond") and f != cmd:
                pass # it's usually just indicating related states
            else:
                inner[f] = f"waarde_{f}"
                
        if inner:
            # For incoming, it's sometimes flat, sometimes nested. Let's nest by default without the _respond.
            # actually let's just make it flat for values if it's typical mqtt. Wait, standard is flat inside the payload
            # but let's nest it under value or the command for clarity. Let's just flat it.
            for k, v in inner.items():
                data[k] = v

    import json
    return json.dumps(data, indent=2)

lines = text.split("\n")
current_mode = None

for line in lines:
    if line.startswith("## 📤 Verzonden"):
        current_mode = "sent"
        out.append(line)
        continue
    elif line.startswith("## 📥 Ontvangen"):
        current_mode = "received"
        out.append(line)
        continue
    elif line.startswith("### Continue Apparaat State"):
        current_mode = "state"
        out.append(line)
        continue
        
    m = re.match(r'\|\s*\*\*`([^`]+)`\*\*\s*\|\s*(.*?)\s*\|', line)
    if m:
        cmd = m.group(1)
        fields_str = m.group(2)
        
        # parse fields, removing backticks and extra info
        raw_fields = [f.strip().strip("`").split(" ")[0] for f in fields_str.replace(",", "").split("`") if f.strip() not in [",", "", "|"] and not f.startswith("(")]
        # additional cleanup
        fields = [f.replace("`", "").replace(",", "") for f in fields_str.split() if "`" in f]
        
        out.append(f"### `{cmd}`")
        out.append(f"**Payload parameters:** {fields_str}")
        out.append("**Voorbeeld Payload:**")
        out.append("```json")
        out.append(make_json(cmd, fields, current_mode != "sent"))
        out.append("```")
        out.append("---")
        out.append("")
    else:
        # ignore table header lines
        if not line.startswith("|") and not line.startswith("---") and not line.startswith("| :---"):
            out.append(line)

with open("novabot_commands_reference.md", "w", encoding="utf-8") as f:
    f.write("\n".join(out))

print("Created novabot_commands_reference.md")
