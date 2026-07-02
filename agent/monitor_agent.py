#!/usr/bin/env python3
"""Unified GPU Monitor Agent — single self-contained binary for Linux.

Detects available GPU tools automatically and serves telemetry via HTTP.

Supported GPUs:
  - AMD ROCm (amd-smi + rocm-smi)
  - Intel XPU (xpu-smi)

Usage:
    ./monitor_agent              # auto-detect GPU type
    ./monitor_agent --type rocm  # force ROCm mode
    ./monitor_agent --type xpu   # force XPU mode
    ./monitor_agent --port 6000  # custom port

Environment:
    PORT  — HTTP port (default: 5900)
"""

import json
import os
import subprocess
import sys
import argparse
from datetime import datetime, timezone
from http.server import HTTPServer, BaseHTTPRequestHandler


PORT = int(os.environ.get("PORT", "5900"))


def run_cmd(cmd, timeout=15):
    """Run a shell command and return (stdout, stderr, returncode)."""
    try:
        result = subprocess.run(
            cmd, shell=True, capture_output=True, text=True, timeout=timeout
        )
        return result.stdout.strip(), result.stderr.strip(), result.returncode
    except subprocess.TimeoutExpired:
        return "", "Command timed out", 1


def detect_gpu_type():
    """Auto-detect available GPU tools."""
    has_amd = run_cmd("amd-smi --version 2>&1")[2] == 0
    has_xpu = run_cmd("xpu-smi --version 2>&1")[2] == 0

    if has_amd and has_xpu:
        return "both"
    elif has_amd:
        return "rocm"
    elif has_xpu:
        return "xpu"
    else:
        return None


# ── AMD ROCm parser ──────────────────────────────────────────────

def _calc_fan_pct(fan_speed, fan_max):
    try:
        speed = float(fan_speed)
        max_val = float(fan_max)
        if max_val > 0:
            return round((speed / max_val) * 100, 1)
    except (TypeError, ValueError):
        pass
    return 0


def parse_amdsmi_json():
    """Parse amd-smi JSON output for all GPUs."""
    gpus = []

    # Get GPU names once (static info)
    gpu_names = {}
    raw_static, _, _ = run_cmd("amd-smi static 2>&1")
    current_gpu = None
    for line in raw_static.split('\n'):
        if line.startswith('GPU: '):
            current_gpu = int(line.split(':')[1].strip())
        elif 'MARKET_NAME' in line and current_gpu is not None:
            gpu_names[current_gpu] = line.split(':', 1)[1].strip()

    # Get static info (VRAM, model) for each GPU
    raw_static_vram, _, _ = run_cmd("amd-smi static --vram --json 2>&1")
    static_data = {}
    if raw_static_vram:
        try:
            static_json = json.loads(raw_static_vram)
            for entry in static_json.get('gpu_data', []):
                gpu_id = entry.get('gpu')
                vram_info = entry.get('vram', {})
                static_data[gpu_id] = {
                    'total_vram': vram_info.get('size', {}).get('value', 0) if isinstance(vram_info.get('size'), dict) else vram_info.get('size', 0),
                    'vram_type': vram_info.get('type', 'N/A'),
                    'vram_vendor': vram_info.get('vendor', 'N/A'),
                }
        except json.JSONDecodeError:
            pass

    # Get metric data (temp, power, fan, usage, VRAM used) for each GPU
    raw_metric, _, _ = run_cmd("amd-smi metric --temperature --power --fan --mem-usage --clock --usage --json 2>&1")
    metric_data = {}
    if raw_metric:
        try:
            metric_json = json.loads(raw_metric)
            for entry in metric_json.get('gpu_data', []):
                gpu_id = entry.get('gpu')
                usage = entry.get('usage', {})

                def safe_dict_get(d, *keys, default=None):
                    for k in keys:
                        if isinstance(d, dict):
                            d = d.get(k, default)
                        else:
                            return default
                    return d

                metric_data[gpu_id] = {
                    'temperature': safe_dict_get(entry, 'temperature', 'edge', 'value', default=0),
                    'hotspot_temp': safe_dict_get(entry, 'temperature', 'hotspot', 'value', default=None),
                    'mem_temp': safe_dict_get(entry, 'temperature', 'mem', 'value', default=None),
                    'power': safe_dict_get(entry, 'power', 'socket_power', 'value', default=0),
                    'fan_speed': entry.get('fan', {}).get('speed', 0) if isinstance(entry.get('fan'), dict) else 0,
                    'fan_max': entry.get('fan', {}).get('max', 255) if isinstance(entry.get('fan'), dict) else 255,
                    'fan_rpm': entry.get('fan', {}).get('rpm', 0) if isinstance(entry.get('fan'), dict) else 0,
                    'fan_pct': safe_dict_get(entry, 'fan', 'usage', 'value', default=None) if isinstance(entry.get('fan'), dict) else None,
                    'gfx_usage': safe_dict_get(usage, 'gfx_activity', 'value', default=0) if isinstance(usage, dict) else None,
                    'clock_gfx': safe_dict_get(entry, 'clock', 'gfx_0', 'clk', 'value', default=0),
                    'clock_mem': safe_dict_get(entry, 'clock', 'mem_0', 'clk', 'value', default=0),
                }
        except json.JSONDecodeError:
            pass

    # Fallback to rocm-smi for utilization on RDNA3
    util_data = {}
    raw_util, _, _ = run_cmd("rocm-smi --showutilization 2>&1")
    if raw_util:
        for line in raw_util.split('\n'):
            if 'GPU:' in line and ('Kernel-Compute' in line or 'Compute' in line):
                try:
                    gpu_id = int(line.split('GPU:')[1].split(':')[0].strip())
                    parts = line.split(':')
                    for p in parts[2:]:
                        p = p.strip()
                        if '%' in p:
                            pct_str = p.replace('%', '').strip()
                            try:
                                util_data[gpu_id] = float(pct_str)
                            except ValueError:
                                pass
                            break
                except (ValueError, IndexError):
                    pass

    # Get VRAM usage
    raw_mem, _, _ = run_cmd("amd-smi metric --mem-usage --json 2>&1")
    mem_data = {}
    if raw_mem:
        try:
            mem_json = json.loads(raw_mem)
            for entry in mem_json.get('gpu_data', []):
                gpu_id = entry.get('gpu')
                vram = entry.get('mem_usage', {})
                used = vram.get('used_vram', {})
                total = vram.get('total_vram', {})
                free = vram.get('free_vram', {})
                mem_data[gpu_id] = {
                    'used_vram': used.get('value', 0) if isinstance(used, dict) else 0,
                    'total_vram': total.get('value', 0) if isinstance(total, dict) else 0,
                    'free_vram': free.get('value', 0) if isinstance(free, dict) else 0,
                }
        except json.JSONDecodeError:
            pass

    # Build unified GPU records
    all_gpu_ids = sorted(set(list(static_data.keys()) + list(metric_data.keys()) + list(mem_data.keys())))

    for gpu_id in all_gpu_ids:
        static = static_data.get(gpu_id, {})
        metric = metric_data.get(gpu_id, {})
        mem = mem_data.get(gpu_id, {})

        total_vram = mem.get('total_vram', 0) or static.get('total_vram', 0)
        used_vram = mem.get('used_vram', 0)
        free_vram = mem.get('free_vram', 0)

        vram_percent = round((used_vram / total_vram) * 100, 2) if total_vram > 0 else 0

        gpu = {
            'device_id': gpu_id,
            'name': gpu_names.get(gpu_id, f'GPU {gpu_id}'),
            'temperature': metric.get('temperature', 0),
            'hotspot_temp': metric.get('hotspot_temp'),
            'mem_temp': metric.get('mem_temp'),
            'power_draw': metric.get('power', 0),
            'fan_speed': metric.get('fan_speed', 0),
            'fan_max': metric.get('fan_max', 255),
            'fan_rpm': metric.get('fan_rpm', 0),
            'fan_pct': metric.get('fan_pct') or _calc_fan_pct(metric.get('fan_speed'), metric.get('fan_max')) if metric.get('fan_speed') else 0,
            'gpu_use': util_data.get(gpu_id, metric.get('gfx_usage', 0) if metric.get('gfx_usage') is not None else 0),
            'vram_percent': vram_percent,
            'memory_total': total_vram,
            'memory_used': used_vram,
            'memory_free': free_vram,
            'sclk': f"{metric.get('clock_gfx', 0)} Mhz" if metric.get('clock_gfx') else 'N/A',
            'mclk': f"{metric.get('clock_mem', 0)} Mhz" if metric.get('clock_mem') else 'N/A',
        }
        gpus.append(gpu)

    return gpus


# ── Intel XPU parser ─────────────────────────────────────────────

def discover_xpu_gpus():
    """Discover all Intel GPUs."""
    raw, _, rc = run_cmd("xpu-smi --list-gpus")
    if rc != 0 or not raw:
        return []

    gpus = []
    for line in raw.strip().split("\n"):
        parts = line.split()
        if len(parts) >= 3:
            try:
                idx = int(parts[0])
                gpu_id = parts[1]
                name = " ".join(parts[2:])
                gpus.append({"index": idx, "device_id": gpu_id, "name": name})
            except ValueError:
                continue
    return gpus


def query_xpu_fields(device_id, fields):
    cmd = f"xpu-smi --query-gpu={fields} --id {device_id} -j 2>&1"
    raw, _, rc = run_cmd(cmd)
    if rc != 0 or not raw:
        return {}
    try:
        data = json.loads(raw)
        if isinstance(data, list) and len(data) > 0:
            return data[0]
        return data
    except json.JSONDecodeError:
        return {}


def get_xpu_stats(device_id):
    cmd = f"xpu-smi stats --device {device_id} -j"
    raw, _, rc = run_cmd(f"{cmd} 2>&1")
    if rc != 0 or not raw:
        return {}
    try:
        data = json.loads(raw)
        if isinstance(data, list) and len(data) > 0:
            return data[0]
        return data
    except json.JSONDecodeError:
        return {}


def parse_xpu_gpu(device_info):
    idx = device_info["index"]

    identity = query_xpu_fields(
        device_info["device_id"],
        "name,serial,driver_version,vbios_version,pci.bus_id,pci.device_id"
    )
    stats = get_xpu_stats(device_info["device_id"])

    temp = 0
    mem_temp = 0
    if "temperature" in stats:
        t = stats["temperature"]
        temp = t.get("gpu", 0) or t.get("gpu_celsius", 0) or 0
        mem_temp = t.get("memory", 0) or t.get("memory_celsius", 0) or 0

    power_draw = 0
    if "power" in stats:
        p = stats["power"]
        power_draw = p.get("draw", 0) or p.get("average", 0) or 0

    mem_used = 0
    mem_total = 0
    mem_free = 0
    if "memory" in stats:
        m = stats["memory"]
        mem_total = m.get("total", 0) or m.get("total_mib", 0) or 0
        mem_used = m.get("used", 0) or m.get("used_mib", 0) or 0
        mem_free = m.get("free", 0) or m.get("free_mib", 0) or 0

    gpu_util = 0
    if "utilization" in stats:
        u = stats["utilization"]
        gpu_util = u.get("gpu", 0) or u.get("total", 0) or 0

    fan_speed = 0
    if "fan" in stats:
        fans = stats["fan"]
        if isinstance(fans, list):
            fan_speed = fans[0].get("speed_percent", 0) if fans else 0
        elif isinstance(fans, dict):
            fan_speed = fans.get("speed_percent", 0) or fans.get("speed", 0) or 0

    sclk = None
    mclk = None
    if "clock" in stats:
        c = stats["clock"]
        sclk = c.get("graphics", 0) or c.get("current_graphics_mhz", 0) or None
        mclk = c.get("media", 0) or c.get("current_media_mhz", 0) or None

    vram_percent = (mem_used / mem_total * 100) if mem_total > 0 else 0

    return {
        "device_id": device_info["device_id"],
        "index": idx,
        "name": identity.get("name", device_info.get("name", f"Intel GPU {idx}")),
        "serial": identity.get("serial", ""),
        "driver_version": identity.get("driver_version", ""),
        "temperature": temp,
        "mem_temp": mem_temp,
        "power_draw": power_draw,
        "memory_used": round(mem_used, 1),
        "memory_total": round(mem_total, 1),
        "memory_free": round(mem_free, 1),
        "vram_percent": round(vram_percent, 2),
        "gpu_use": gpu_util,
        "fan_speed": fan_speed,
        "sclk": sclk,
        "mclk": mclk,
    }


def get_all_xpu_gpus():
    devices = discover_xpu_gpus()
    if not devices:
        for i in range(4):
            raw, _, rc = run_cmd(f"xpu-smi --query-gpu=name --id {i} -j 2>&1")
            if rc == 0 and raw:
                try:
                    data = json.loads(raw)
                    if isinstance(data, list) and len(data) > 0 and data[0].get("name"):
                        devices.append({"index": i, "device_id": str(i), "name": data[0]["name"]})
                except json.JSONDecodeError:
                    pass
    return [parse_xpu_gpu(d) for d in devices]


# ── HTTP Server ──────────────────────────────────────────────────

class MonitorHandler(BaseHTTPRequestHandler):
    """HTTP handler for GPU telemetry API."""

    def log_message(self, format, *args):
        pass  # suppress logging

    def do_GET(self):
        path = self.path.rstrip("/")

        if path in ("/api/rocm", "/api/rocm/"):
            gpus = parse_amdsmi_json()
            self._send_json(200, {
                "source": "amd-rocm",
                "tool": "amd-smi",
                "gpus": gpus,
                "timestamp": datetime.now(timezone.utc).isoformat(),
            })

        elif path in ("/api/xpu", "/api/xpu/"):
            gpus = get_all_xpu_gpus()
            self._send_json(200, {
                "source": "intel-xpu",
                "tool": "xpu-smi",
                "gpus": gpus,
                "timestamp": datetime.now(timezone.utc).isoformat(),
            })

        elif path in ("/api/rocm/raw", "/api/rocm/raw/"):
            raw, err, rc = run_cmd("amd-smi metric --temperature --power --fan --mem-usage --clock --json 2>&1")
            self._send_json(200, {"output": raw, "error": err if rc != 0 else ""})

        elif path in ("/api/xpu/raw", "/api/xpu/raw/"):
            devices = discover_xpu_gpus()
            raw_data = {}
            for d in devices:
                raw_data[d["device_id"]] = {
                    "identity": query_xpu_fields(d["device_id"], "name,serial,driver_version"),
                    "stats": get_xpu_stats(d["device_id"]),
                }
            self._send_json(200, {"discovered_gpus": devices, "raw_data": raw_data})

        elif path in ("/health", "/health/"):
            # Auto-detect and report available GPU type
            gpu_type = detect_gpu_type()
            self._send_json(200, {
                "status": "ok",
                "service": "gpu-monitor-agent",
                "gpu_type": gpu_type,
                "timestamp": datetime.now(timezone.utc).isoformat(),
            })

        else:
            self._send_json(404, {"error": "Not found"})

    def _send_json(self, status_code, data):
        self.send_response(status_code)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(json.dumps(data, indent=2).encode())


def main():
    parser = argparse.ArgumentParser(description="GPU Monitor Agent for Linux")
    parser.add_argument("--type", choices=["rocm", "xpu", "auto"], default="auto",
                        help="GPU type to monitor (default: auto-detect)")
    parser.add_argument("--port", type=int, default=PORT,
                        help=f"HTTP port (default: {PORT})")
    args = parser.parse_args()

    # Auto-detect if not forced
    if args.type == "auto":
        gpu_type = detect_gpu_type()
        if gpu_type is None:
            print("ERROR: No GPU tools found. Install amd-smi or xpu-smi.")
            sys.exit(1)
        print(f"Auto-detected GPU type: {gpu_type}")
    else:
        gpu_type = args.type

    # Validate
    if gpu_type not in ("rocm", "xpu"):
        print(f"ERROR: Detected GPU type '{gpu_type}' is not supported. Use --type rocm or --type xpu.")
        sys.exit(1)

    tool_name = "amd-smi" if gpu_type == "rocm" else "xpu-smi"
    _, _, rc = run_cmd(f"{tool_name} --version 2>&1")
    if rc != 0:
        print(f"ERROR: {tool_name} not found. Is it installed?")
        sys.exit(1)

    # Show discovered GPUs
    if gpu_type == "rocm":
        gpus = parse_amdsmi_json()
    else:
        gpus = get_all_xpu_gpus()

    print(f"Discovered {len(gpus)} GPU(s):")
    for g in gpus:
        name = g.get("name", f"GPU {g.get('device_id', '?')}")
        mem = g.get("memory_total", 0)
        print(f"  GPU {g['device_id']}: {name} ({mem} MB VRAM)")

    server = HTTPServer(("0.0.0.0", args.port), MonitorHandler)
    print(f"Serving on http://0.0.0.0:{args.port}")
    print(f"  /api/rocm   — AMD ROCm telemetry")
    print(f"  /api/xpu    — Intel XPU telemetry")
    print(f"  /health     — Health check")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nShutting down...")
        server.shutdown()


if __name__ == "__main__":
    main()
