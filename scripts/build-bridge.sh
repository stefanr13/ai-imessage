#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."
mkdir -p .bin
swiftc swift/messages_ax.swift -o .bin/messages-ax
