#!/bin/bash
# Build a standalone Linux binary for GPU Monitor Agent using PyInstaller.
#
# Requirements (on the build machine):
#   - Python 3.9+
#   - pip install flask pyinstaller
#   - Must run on Linux (x86_64 or aarch64)
#
# Usage:
#   chmod +x scripts/build_linux.sh
#   bash scripts/build_linux.sh
#
# Output: dist/monitor_agent (Linux ELF binary)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
AGENT_DIR="$PROJECT_DIR/agent"
OUTPUT_DIR="$PROJECT_DIR/dist"

echo "=== GPU Monitor Agent — Linux Build ==="
echo "Project: $PROJECT_DIR"
echo ""

# Check Python
if ! command -v python3 &>/dev/null; then
    echo "ERROR: python3 not found. Install Python 3.9+."
    exit 1
fi

PYTHON=$(which python3)
echo "Python: $PYTHON ($($PYTHON --version 2>&1))"

# Check/install dependencies
echo ""
echo "Checking dependencies..."
$PYTHON -c "import flask" 2>/dev/null || pip3 install flask
$PYTHON -c "import PyInstaller" 2>/dev/null || pip3 install pyinstaller

# Clean previous build
echo ""
echo "Cleaning previous build..."
rm -rf "$OUTPUT_DIR"/monitor_agent "$OUTPUT_DIR"/monitor_agent.spec
mkdir -p "$OUTPUT_DIR"

# Build with PyInstaller (one-file mode)
echo "Building Linux binary..."
$PYTHON -m PyInstaller \
    --name monitor_agent \
    --onefile \
    --clean \
    --noconfirm \
    --hidden-import=json \
    --hidden-import=subprocess \
    --hidden-import=datetime \
    --hidden-import=http.server \
    --distpath "$OUTPUT_DIR" \
    --workpath "$PROJECT_DIR/.build_cache" \
    "$AGENT_DIR/monitor_agent.py"

# Verify output
BINARY="$OUTPUT_DIR/monitor_agent"
if [ -f "$BINARY" ]; then
    chmod +x "$BINARY"
    SIZE=$(du -h "$BINARY" | cut -f1)
    echo ""
    echo "=== Build successful ==="
    echo "Binary: $BINARY"
    echo "Size:   $SIZE"
    echo ""
    echo "Deploy to target machine:"
    echo "  scp $BINARY user@remote:/opt/gpu-monitor/"
    echo ""
    echo "Run on target:"
    echo "  ./monitor_agent              # auto-detect GPU type"
    echo "  ./monitor_agent --type rocm  # force ROCm"
    echo "  ./monitor_agent --type xpu   # force XPU"
    echo "  ./monitor_agent --port 6000  # custom port"
else
    echo "ERROR: Binary not found at $BINARY"
    exit 1
fi

# Cleanup build cache
rm -rf "$PROJECT_DIR/.build_cache"
