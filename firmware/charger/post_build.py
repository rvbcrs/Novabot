Import("env")
import os, re, shutil, json, hashlib

def copy_firmware(source, target, env):
    # Read version from config.h
    config_path = os.path.join(env["PROJECT_DIR"], "include", "config.h")
    version = "unknown"
    with open(config_path, "r") as f:
        for line in f:
            m = re.search(r'#define\s+FIRMWARE_VERSION\s+"([^"]+)"', line)
            if m:
                version = m.group(1)
                break

    # Create firmware output directory
    fw_dir = os.path.join(env["PROJECT_DIR"], "firmware")
    os.makedirs(fw_dir, exist_ok=True)

    # Copy .bin with version name
    src_bin = str(source[0])
    bin_name = f"OpenNova-{version}.bin"
    dst_bin = os.path.join(fw_dir, bin_name)
    shutil.copy2(src_bin, dst_bin)

    # Calculate MD5
    md5 = hashlib.md5(open(dst_bin, "rb").read()).hexdigest()

    # Write metadata JSON
    meta = {
        "version": version,
        "device_type": "charger",
        "filename": bin_name,
        "md5": md5,
        "description": "OpenNova charger firmware (ESP32-S3)",
    }
    json_path = os.path.join(fw_dir, f"OpenNova-{version}.json")
    with open(json_path, "w") as f:
        json.dump(meta, f, indent=2)

    print(f"Firmware: firmware/{bin_name} (md5: {md5})")

env.AddPostAction("$BUILD_DIR/firmware.bin", copy_firmware)
