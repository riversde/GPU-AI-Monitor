#!/usr/bin/env python3
"""ROCM telemetry agent — runs on the AI PC, exposes GPU data as JSON.

Uses amd-smi (AMD System Management Interface) for accurate hardware telemetry
instead of rocm-smi. amd-smi reports correct VRAM sizes, fan speeds, and
comprehensive metrics for AMD RDNA3/MI300-class GPUs.
"""

import json
import subprocess
from datetime import datetime, timezone
from flask import Flask, jsonify, request

app = Flask(__name__)


def run_cmd(cmd, timeout=15):
    """Run a shell command and return stdout, stderr, exit code."""
    try:
        result = subprocess.run(
            cmd, shell=True, capture_output=True, text=True, timeout=timeout
        )
        return result.stdout.strip(), result.stderr.strip(), result.returncode
    except subprocess.TimeoutExpired:
        return "", "Command timed out", 1


def get_gpu_name(device_id):
    """Get the GPU model name from amd-smi static output."""
    raw, _, _ = run_cmd(f"amd-smi static -g {device_id} 2>&1")
    for line in raw.split('\n'):
        if 'MARKET_NAME' in line:
            return line.split(':', 1)[1].strip()
    return None


# ── Device ID → Market Name lookup ────────────────────────────────
# amd-smi reports a generic "AMD Radeon Graphics" for several RDNA4
# chips; the unique DEVICE_ID (and optional SUBSYSTEM_ID) resolves it.
GPU_NAME_MAP = {
    # RDNA4 – Navi48  (W9700 PRO)
    (0x7551, 0x5413): "Radeon PRO W9700 PRO",
    (0x7551,):         "Radeon PRO W9700 PRO",
    # RDNA4 – Navi44  (RX 9060 XT)
    (0x7590, 0x5407): "Radeon RX 9060 XT",
    (0x7590,):        "Radeon RX 9060 XT",
}


def _resolve_gpu_name(device_id_hex, subsystem_id_hex=None):
    """Resolve a GPU DEVICE_ID to its human-readable market name."""
    if not device_id_hex:
        return None
    try:
        did = int(str(device_id_hex), 16)
    except (TypeError, ValueError):
        return None

    # Try (DEVICE_ID, SUBSYSTEM_ID) first, then DEVICE_ID only
    key = (did, subsystem_id_hex) if subsystem_id_hex else (did,)
    if key in GPU_NAME_MAP:
        return GPU_NAME_MAP[key]
    # Fallback: try just the device ID against all entries
    for map_key, name in GPU_NAME_MAP.items():
        if map_key[0] == did:
            return name
    return None


def _calc_fan_pct(fan_speed, fan_max):
    """Calculate fan percentage from raw PWM values, handling non-numeric max."""
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

    # Extract GPU IDs (device_id, subsystem_id) from static text output
    # so we can resolve generic MARKET_NAME labels to actual product names.
    gpu_ids_map = {}
    raw_static, _, _ = run_cmd("amd-smi static 2>&1")
    current_gpu = None
    for line in raw_static.split('\n'):
        if line.startswith('GPU: '):
            current_gpu = int(line.split(':')[1].strip())
        elif 'DEVICE_ID' in line and current_gpu is not None:
            gpu_ids_map[current_gpu] = {
                'device_id': line.split(':', 1)[1].strip(),
                'subsystem_id': None,
                'market_name': None,
            }
        elif 'SUBSYSTEM_ID' in line and current_gpu in gpu_ids_map:
            gpu_ids_map[current_gpu]['subsystem_id'] = line.split(':', 1)[1].strip()
        elif 'MARKET_NAME' in line and current_gpu in gpu_ids_map:
            gpu_ids_map[current_gpu]['market_name'] = line.split(':', 1)[1].strip()

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
                
                # Safe extraction helpers
                def safe_dict_get(d, *keys, default=None):
                    """Safely traverse nested dicts, returning default on any non-dict."""
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

    # amd-smi metric doesn't always report GPU utilization on RDNA3.
    # Fallback to rocm-smi --showutilization for the utilization percentage.
    util_data = {}
    raw_util, _, _ = run_cmd("rocm-smi --showutilization 2>&1")
    if raw_util:
        for line in raw_util.split('\n'):
            # Format: GPU: ... Kernel-Compute % ...
            # e.g. "GPU:0: 18%" or "GPU:0: Kernel-Compute : 45 %"
            if 'GPU:' in line and ('Kernel-Compute' in line or 'Compute' in line):
                try:
                    gpu_id = int(line.split('GPU:')[1].split(':')[0].strip())
                    # Extract percentage number
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

    # Also try parsing "Kernel-Compute : XX %" format
    if raw_util and not util_data:
        for line in raw_util.split('\n'):
            if 'GPU:' in line and 'Kernel-Compute' in line:
                try:
                    gpu_id = int(line.split('GPU:')[1].split(':')[0].strip())
                    # Find the number before %
                    import re
                    match = re.search(r':\s*(\d+(?:\.\d+)?)\s*%', line)
                    if match:
                        util_data[gpu_id] = float(match.group(1))
                except (ValueError, IndexError):
                    pass

    # Get VRAM usage (used/free) from metric data
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

        # Determine total VRAM from the most reliable source
        total_vram = mem.get('total_vram', 0) or static.get('total_vram', 0)
        used_vram = mem.get('used_vram', 0)
        free_vram = mem.get('free_vram', 0)

        # Calculate percentage
        if total_vram > 0:
            vram_percent = round((used_vram / total_vram) * 100, 2)
        else:
            vram_percent = 0

        # Resolve name: prefer DEVICE_ID lookup (handles generic "AMD Radeon Graphics")
        resolved_name = None
        if gpu_id in gpu_ids_map:
            did = gpu_ids_map[gpu_id].get('device_id')
            sid = gpu_ids_map[gpu_id].get('subsystem_id')
            resolved_name = _resolve_gpu_name(did, sid)

        gpu = {
            'device_id': gpu_id,
            'name': resolved_name or gpu_ids_map.get(gpu_id, {}).get('market_name', f'GPU {gpu_id}'),
            'temperature': metric.get('temperature', 0),
            'hotspot_temp': metric.get('hotspot_temp'),
            'mem_temp': metric.get('mem_temp'),
            'power_draw': metric.get('power', 0),
            'fan_speed': metric.get('fan_speed', 0),       # raw 0-255 (for reference)
            'fan_max': metric.get('fan_max', 255),           # raw max
            'fan_rpm': metric.get('fan_rpm', 0),             # actual RPM
            'fan_pct': metric.get('fan_pct') or _calc_fan_pct(metric.get('fan_speed'), metric.get('fan_max')) if metric.get('fan_speed') else 0,  # authoritative %
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


@app.route('/health')
def health():
    """Health check endpoint."""
    return jsonify({
        'status': 'ok',
        'service': 'rocm-monitor-agent',
        'tool': 'amd-smi',
        'timestamp': datetime.now(timezone.utc).isoformat(),
    })


@app.route('/api/rocm/raw')
def rocm_raw():
    """Raw amd-smi output for debugging."""
    raw, err, rc = run_cmd("amd-smi metric --temperature --power --fan --mem-usage --clock --json 2>&1")
    return jsonify({
        'output': raw,
        'error': err if rc != 0 else '',
    })


@app.route('/api/rocm/debug')
def rocm_debug():
    """Debug endpoint: show raw amd-smi metric JSON for a specific GPU."""
    device_id = request.args.get('gpu', 0)
    raw, err, rc = run_cmd(f"amd-smi metric --json -g {device_id} 2>&1")
    return jsonify({
        'output': raw,
        'error': err if rc != 0 else '',
        'parsed': None,
    })


@app.route('/api/rocm')
def rocm_api():
    """Parse amd-smi JSON output and return clean GPU telemetry."""
    gpus = parse_amdsmi_json()

    return jsonify({
        'gpus': gpus,
        'timestamp': datetime.now(timezone.utc).isoformat(),
    })


if __name__ == '__main__':
    app.run(host='0.0.0.0', port=5900)
