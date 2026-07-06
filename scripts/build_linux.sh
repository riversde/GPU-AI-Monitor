#!/bin/bash
# Linux build script for GPU Monitor for AI Workloads
# Target: AppImage (universal) + tar.gz (portable)
# Requires: Node.js 18+, electron-builder, libgtk-3-dev, libnotify-dev, libnss3, libxss1, libxtst6

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
BUILD_DIR="$PROJECT_DIR/dist"
VERSION=$(cd "$PROJECT_DIR" && node -p "require('./package.json').version")

echo "═══════════════════════════════════════════════════"
echo " GPU Monitor for AI Workloads - Linux Build"
echo "═══════════════════════════════════════════════════"
echo "  Version:  $VERSION"
echo "  Project:  $PROJECT_DIR"
echo "  Build dir: $BUILD_DIR"
echo ""

# ── Step 1: Detect distro ──────────────────────────────
echo "▶ Step 1: Detecting distro..."
if [ -f /etc/os-release ]; then
    . /etc/os-release
    DISTRO="$NAME $VERSION_ID"
    PKG_MGR=""
    case "$ID" in
        ubuntu|debian) PKG_MGR="apt" ;;
        fedora|rhel|centos|almalinux|rocky) PKG_MGR="dnf" ;;
        arch|manjaro) PKG_MGR="pacman" ;;
        *) echo "  ⚠ Unknown distro: $ID - will use apt/yum as fallback" ;;
    esac
else
    echo "  ⚠ Cannot detect distro (no /etc/os-release)"
    PKG_MGR="unknown"
fi
echo "  Distro: $DISTRO"
echo "  Package mgr: $PKG_MGR"
echo ""

# ── Step 2: Install dependencies ───────────────────────
echo "▶ Step 2: Installing build dependencies..."

install_apt_deps() {
    sudo apt-get update -qq
    sudo apt-get install -y --no-install-recommends \
        libgtk-3-dev libnotify-dev libnss3 libxss1 libxtst6 \
        xdg-utils fonts-liberation libatspi2.0-dev \
        libgbm1 libasound2t64 libpangocairo-1.0-0 \
        wget tar
}

install_dnf_deps() {
    sudo dnf install -y \
        gtk3-devel libnotify nss at-spi2-atk libXScrnSaver \
        libXtst alsa-lib glibc glibc-devel libgbm
}

install_pacman_deps() {
    sudo pacman -Syu --noconfirm --needed \
        gtk3 libnotify nss at-spi2-atk libxss libxtst \
        alsa-lib glibc libgbm
}

if [ "$PKG_MGR" = "apt" ]; then
    install_apt_deps
elif [ "$PKG_MGR" = "dnf" ]; then
    install_dnf_deps
elif [ "$PKG_MGR" = "pacman" ]; then
    install_pacman_deps
else
    echo "  ⚠ Unknown package manager, attempting apt..."
    install_apt_deps 2>/dev/null || install_dnf_deps 2>/dev/null || echo "  ⚠ Dependency install may fail - proceeding anyway"
fi

echo "  ✓ Dependencies installed"
echo ""

# ── Step 3: Ensure Node.js ─────────────────────────────
echo "▶ Step 3: Checking Node.js..."
NODE_VER=$(node --version 2>/dev/null || echo "not found")
echo "  Node: $NODE_VER"
if [[ "$NODE_VER" == v* ]] && [[ "${NODE_VER#v}" != 1* ]]; then
    echo "  ⚠ Node.js version might be too old (need 18+)"
fi
echo ""

# ── Step 4: Install project deps ───────────────────────
echo "▶ Step 4: Installing project dependencies..."
cd "$PROJECT_DIR"
npm ci --ignore-scripts 2>&1 || npm install --ignore-scripts 2>&1
echo "  ✓ Dependencies installed"
echo ""

# ── Step 5: Build with electron-builder ────────────────
echo "▶ Step 5: Building Linux packages..."
mkdir -p "$BUILD_DIR"

npx electron-builder --linux --x64 --config electron-builder.yml 2>&1

echo ""

# ── Step 6: Verify artifacts ───────────────────────────
echo "▶ Step 6: Verifying artifacts..."
echo ""
for f in "$BUILD_DIR"/*.AppImage "$BUILD_DIR"/*.tar.gz; do
    if [ -f "$f" ]; then
        SIZE=$(du -h "$f" | cut -f1)
        echo "  ✓ $(basename "$f") ($SIZE)"
    fi
done
echo ""

# ── Step 7: Create release artifacts dir ───────────────
RELEASE_DIR="$PROJECT_DIR/releases/linux"
mkdir -p "$RELEASE_DIR"
cp "$BUILD_DIR"/*.AppImage "$RELEASE_DIR/" 2>/dev/null || true
cp "$BUILD_DIR"/*.tar.gz "$RELEASE_DIR/" 2>/dev/null || true

echo "  Release artifacts: $RELEASE_DIR/"
for f in "$RELEASE_DIR"/*; do
    [ -f "$f" ] && echo "    $(basename "$f") ($(du -h "$f" | cut -f1))"
done
echo ""

# ── Step 8: Create systemd service ─────────────────────
echo "▶ Step 8: Creating systemd service unit..."
cat > "$RELEASE_DIR/gpu-monitor-ai.service" << 'EOF'
[Unit]
Description=GPU Monitor for AI Workloads
After=network.target

[Service]
Type=simple
User=%i
ExecStart=/opt/GPU-Monitor-AI/GPU%20Monitor%20for%20AI%20Workloads
Restart=on-failure
RestartSec=5
Environment=DISPLAY=:0

[Install]
WantedBy=multi-user.target
EOF

echo "  ✓ Service unit: $RELEASE_DIR/gpu-monitor-ai.service"
echo ""

# ── Done ───────────────────────────────────────────────
echo "═══════════════════════════════════════════════════"
echo " Build complete! ✓"
echo "═══════════════════════════════════════════════════"
echo ""
echo "  To install the portable tar.gz:"
echo "    sudo tar -xzf GPU-Monitor-AI-*.tar.gz -C /opt/"
echo "    sudo ln -sf /opt/GPU-Monitor-AI/GPU\\ Monitor\\ for\\ AI\\ Workloads /usr/local/bin/gpu-monitor"
echo ""
echo "  To install the AppImage:"
echo "    chmod +x GPU-Monitor-AI-*.AppImage"
echo "    sudo mv GPU-Monitor-AI-*.AppImage /opt/"
echo "    sudo ln -sf /opt/GPU-Monitor-AI-*.AppImage /usr/local/bin/gpu-monitor"
echo ""
echo "  To register as desktop app:"
echo "    cp gpu-monitor-ai.desktop ~/.local/share/applications/"
echo ""