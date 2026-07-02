#!/usr/bin/env python3
"""Upload assets to an existing GitHub Release using multipart/form-data."""

import json, subprocess, os, sys, re, urllib.parse

REPO = "riversde/GPU-AI-Monitor"
TOKEN = os.environ.get("GITHUB_TOKEN", "")
DIST_DIR = os.path.join(os.path.dirname(__file__), "..", "dist")

# Get the release ID for v1.0.0
result = subprocess.run(
    [
        "curl", "-s",
        f"https://api.github.com/repos/{REPO}/releases/tags/v1.0.0",
        "-H", f"Authorization: token {TOKEN}",
    ],
    capture_output=True, text=True
)

resp = json.loads(result.stdout)
release_id = resp["id"]
upload_base = re.sub(r'\{[^}]+\}$', '', resp["upload_url"])
print(f"Release v1.0.0 found: ID={release_id}")

def upload_file(filepath, name):
    if not os.path.exists(filepath):
        print(f"SKIP: {filepath} not found")
        return
    file_size = os.path.getsize(filepath)
    url = f"https://uploads.github.com/repos/{REPO}/releases/{release_id}/assets?name={urllib.parse.quote(name)}"
    print(f"Uploading {name} ({file_size / 1024 / 1024:.1f}MB)...")
    
    result = subprocess.run(
        [
            "curl", "-s", "-X", "POST", url,
            "-H", f"Authorization: token {TOKEN}",
            "-F", f"name={name}",
            "-F", f"file=@{filepath};type=application/octet-stream",
        ],
        capture_output=True, text=True
    )
    
    try:
        resp = json.loads(result.stdout)
        if "browser_download_url" in resp:
            print(f"  -> {resp['browser_download_url']}")
        else:
            print(f"  -> Error: {resp}")
    except json.JSONDecodeError:
        print(f"  -> Raw: {result.stdout[:300]}")

# Upload installer
upload_file(
    os.path.join(DIST_DIR, "GPU Monitor for AI Workloads Setup 1.0.0.exe"),
    "GPU Monitor for AI Workloads Setup 1.0.0.exe"
)

# Upload zip of unpacked version
zip_path = os.path.join(DIST_DIR, "GPU-Monitor-AI-v1.0.0-win64.zip")
if not os.path.exists(zip_path):
    print("Creating zip of unpacked version...")
    import zipfile
    with zipfile.ZipFile(zip_path, 'w', zipfile.ZIP_DEFLATED) as zf:
        unpacked = os.path.join(DIST_DIR, "win-unpacked")
        for root, dirs, files in os.walk(unpacked):
            for f in files:
                full = os.path.join(root, f)
                arcname = os.path.relpath(full, DIST_DIR)
                zf.write(full, arcname)
    print(f"Zip created: {os.path.getsize(zip_path) / 1024 / 1024:.1f}MB")

upload_file(zip_path, "GPU-Monitor-AI-v1.0.0-win64.zip")

print("\nDone! Release ready at:")
print(f"https://github.com/riversde/GPU-AI-Monitor/releases/tag/v1.0.0")
