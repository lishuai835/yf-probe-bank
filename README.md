# YF Probe Fingerprint Bank (`yf-probe-bank`)

Unified open-source digital fingerprint repository for **YF专用检测工具** (Original Engine + Ikale Engine).

## Current Dataset
- **Version**: `2026.10.25.1`
- **Candidate Models**: `66` deduplicated LLM fingerprints
- **Built At**: `2026-10-25T12:00:00.000Z`

## Repository Layout
- `data/bank-manifest.json` — Version metadata & SHA-256 integrity manifest
- `data/unified_bank.json` — 355-bin empirical distribution & Hellinger/TVD/Tail reference bank (`66` models, SHA-256: `cdac3c52ebd21ab3df81d78776e5adb8719e8b3514655e361bde2abf8837422e`)
- `data/shared_detector.json` — 7-reference quantized vector archive + `66×429` calibrated LDA projection artifact (SHA-256: `5ed03b5302cc0b505eaa43f3350e994ee5989020386a5518f3a9d5acd33faf7b`)

## Online Update Endpoint
Clicking **在线更新指纹库** in the browser extension downloads and verifies `data/bank-manifest.json`, `data/unified_bank.json`, and `data/shared_detector.json` directly from this repository.
