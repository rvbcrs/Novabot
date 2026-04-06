"""
PlatformIO custom upload script — POST firmware.bin to ESP32 HTTP OTA endpoint.
Usage: pio run -e ota -t upload
"""
Import("env")

def upload_via_http(source, target, env):
    import subprocess, os
    firmware_path = str(source[0])
    upload_url = env.GetProjectOption("upload_port")
    size_kb = os.path.getsize(firmware_path) // 1024

    print(f"\n{'='*50}")
    print(f"  ESP32 OTA Upload")
    print(f"  Firmware: {firmware_path} ({size_kb} KB)")
    print(f"  Target:   {upload_url}")
    print(f"{'='*50}\n")

    result = subprocess.run(
        ["curl", "--progress-bar", "--connect-timeout", "10", "--max-time", "300",
         "-F", f"firmware=@{firmware_path}", upload_url],
    )
    if result.returncode != 0:
        print("\n[ERROR] OTA upload failed!")
        env.Exit(1)
    print("\n[OK] OTA flash complete — device is rebooting...")

env.Replace(UPLOADCMD=upload_via_http)
