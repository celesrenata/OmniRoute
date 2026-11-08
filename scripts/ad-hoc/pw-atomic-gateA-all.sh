#!/bin/zsh
# Gate A: capture every required condition (headed Chrome, real GPU).
cd "$(dirname "$0")/../.."
OUT=OR_ATOM_010_RAYTRACED/screenshots/gateA
B="paused=1&t=3"
node scripts/ad-hoc/pw-atomic-gateA.mjs "$OUT" \
  "gateA-provider-default-1c=golden=provider&models=1&energy=excited&$B" \
  "gateA-provider-default-3c=golden=provider&models=3&energy=excited&$B" \
  "gateA-provider-default-unknown=golden=provider&models=unknown&energy=excited&$B" \
  "gateA-provider-default-stale=golden=provider&models=stale&energy=excited&$B" \
  "gateA-provider-default-3c-idle=golden=provider&models=3&energy=idle&$B" \
  "gateA-provider-close-1c=golden=provider&models=1&energy=excited&dist=close&$B" \
  "gateA-provider-close-3c=golden=provider&models=3&energy=excited&dist=close&$B" \
  "gateA-provider-close-unknown=golden=provider&models=unknown&energy=excited&dist=close&$B" \
  "gateA-provider-close-stale=golden=provider&models=stale&energy=excited&dist=close&$B" \
  "gateA-provider-close-3c-idle=golden=provider&models=3&energy=idle&dist=close&$B" \
  "gateA-gpu-default-3c=golden=gpu&models=3&energy=excited&$B" \
  "gateA-gpu-close-3c=golden=gpu&models=3&energy=excited&dist=close&$B" \
  "gateA-hub-default=golden=hub&models=3&energy=excited&$B" \
  "gateA-hub-close=golden=hub&models=3&energy=excited&dist=close&$B" \
  "gateA-idle-vs-excited=golden=provider&models=3&energy=both&$B" \
  "gateA-3c-az90=golden=provider&models=3&energy=excited&az=90&dist=close&$B" \
  "gateA-3c-az180=golden=provider&models=3&energy=excited&az=180&dist=close&$B" \
  "gateA-3c-az270=golden=provider&models=3&energy=excited&az=270&dist=close&$B" \
  "gateA-webgl2-fallback=golden=provider&models=3&energy=excited&backend=webgl&$B"
