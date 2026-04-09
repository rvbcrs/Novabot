import os, re

asm_dir = "/Users/rvbcrs/GitHub/Novabot/research/blutter_output_v2.4.0/asm/flutter_novabot"
func_regex = re.compile(r"\s_?([a-zA-Z0-9_]+)\(\/\* No info \*\/\)\s*\{(.+?)(?=\n\s_?[a-zA-Z0-9_]+\(\/\* No info \*\/\)\s*\{|\Z)", re.DOTALL)
string_regex = re.compile(r"r\d+\w* = \"([^\"]+)\"")

commands = []

for root, _, files in os.walk(asm_dir):
    for fn in files:
        if fn.endswith(".dart"):
            filepath = os.path.join(root, fn)
            with open(filepath, "r", encoding="utf-8") as file_obj:
                text = file_obj.read()
                
                # Split content into functions approximately
                functions = func_regex.finditer(text)
                for func in functions:
                    func_name = func.group(1)
                    func_body = func.group(2)
                    
                    if "cmd_num" in func_body or "_writeDataToDevice" in func_body or "publishMessage" in func_body or "_sendCommand" in func_body or "_publish" in func_body or "MqttClient" in func_body:
                        strs = string_regex.findall(func_body)
                        clean_strs = [s for s in strs if " " not in s and len(s) > 1 and s not in ["OK", "Cancel", "Yes", "No", "GET", "POST", "null"]]
                        
                        unique_strs = []
                        for s in clean_strs:
                            if s not in unique_strs:
                                unique_strs.append(s)
                                
                        if unique_strs:
                            commands.append((fn, func_name, unique_strs))

for (file_name, func_name, strings) in commands:
    print(f"[{file_name} - {func_name}]: {strings}")
