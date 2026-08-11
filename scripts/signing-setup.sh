#!/usr/bin/env bash
#
# signing-setup.sh — get from "no certificate" to "Developer ID Application
# certificate installed in the login keychain", without needing full Xcode.
#
# Usage:
#   ./scripts/signing-setup.sh            Generate private key + CSR in signing/
#   ./scripts/signing-setup.sh --import   Import the downloaded .cer as a .p12
#   ./scripts/signing-setup.sh --check    Show codesigning identities + notarytool
#
# Working files live in the gitignored `signing/` directory at the repo root.
# Passwords are read interactively and are never echoed, logged, or passed as
# command-line arguments.
#
set -euo pipefail

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "ERROR: this script is macOS-only (code signing requires macOS tooling)." >&2
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
SIGNING_DIR="$PROJECT_ROOT/signing"

KEY_FILE="$SIGNING_DIR/developer-id.key"
CSR_FILE="$SIGNING_DIR/developer-id.csr"
P12_FILE="$SIGNING_DIR/developer-id.p12"

EMAIL="max@mozartdata.com"
SUBJECT="/emailAddress=${EMAIL}/CN=Developer ID Application/C=US"

NOTARYTOOL_FALLBACK="/Library/Developer/CommandLineTools/usr/bin/notarytool"

mode="generate"
if [[ $# -gt 0 ]]; then
  case "$1" in
    --import) mode="import" ;;
    --check)  mode="check" ;;
    -h|--help)
      sed -n '2,15p' "${BASH_SOURCE[0]}"
      exit 0
      ;;
    *)
      echo "ERROR: unknown option: $1" >&2
      echo "Usage: $0 [--import|--check]" >&2
      exit 1
      ;;
  esac
fi

show_identities() {
  echo "Codesigning identities in the keychain:"
  security find-identity -v -p codesigning || true
}

notarytool_status() {
  if xcrun --find notarytool >/dev/null 2>&1; then
    echo "notarytool: found at $(xcrun --find notarytool)"
  elif [[ -x "$NOTARYTOOL_FALLBACK" ]]; then
    echo "notarytool: found at $NOTARYTOOL_FALLBACK"
  else
    echo "notarytool: NOT FOUND (install Xcode Command Line Tools: xcode-select --install)"
  fi
}

case "$mode" in
  check)
    echo "=== Signing environment check ==="
    echo ""
    show_identities
    echo ""
    notarytool_status
    exit 0
    ;;

  generate)
    mkdir -p "$SIGNING_DIR"
    chmod 700 "$SIGNING_DIR"

    if [[ -f "$KEY_FILE" && -f "$CSR_FILE" ]]; then
      echo "Private key and CSR already exist — not overwriting:"
      echo "  $KEY_FILE"
      echo "  $CSR_FILE"
    else
      echo "Generating a 2048-bit RSA private key and certificate signing request..."
      openssl req -new -newkey rsa:2048 -nodes \
        -keyout "$KEY_FILE" \
        -out "$CSR_FILE" \
        -subj "$SUBJECT"
      chmod 600 "$KEY_FILE"
      echo "Created:"
      echo "  $KEY_FILE (private key, chmod 600 — never commit this)"
      echo "  $CSR_FILE (certificate signing request)"
    fi

    cat <<EOF

=== Next steps ===

1. Open https://developer.apple.com/account/resources/certificates/add
2. Choose certificate type "Developer ID Application"
     (under Software -> Developer ID Application; if asked, pick the
      "G2 Sub-CA / Xcode 11 or later" profile type)
3. Upload the CSR file when prompted:
     $CSR_FILE
4. Click Continue, then Download. Apple gives you a file named
   developer_id_application.cer — save (or move) it into:
     $SIGNING_DIR/
5. Run this script again with --import:
     ./scripts/signing-setup.sh --import

EOF
    exit 0
    ;;

  import)
    if [[ ! -f "$KEY_FILE" ]]; then
      echo "ERROR: private key not found at $KEY_FILE" >&2
      echo "Run ./scripts/signing-setup.sh (no flags) first to generate it." >&2
      exit 1
    fi

    CER_FILE=""
    while IFS= read -r candidate; do
      CER_FILE="$candidate"
      break
    done < <(find "$SIGNING_DIR" -maxdepth 1 -type f -name '*.cer' 2>/dev/null | sort)

    if [[ -z "$CER_FILE" ]]; then
      echo "ERROR: no .cer file found in $SIGNING_DIR" >&2
      echo "Download developer_id_application.cer from developer.apple.com and put it there." >&2
      exit 1
    fi
    echo "Using certificate: $CER_FILE"

    # Apple ships the .cer in DER form; convert to PEM for pkcs12 packaging.
    CER_PEM="$SIGNING_DIR/developer-id.cer.pem"
    if openssl x509 -inform DER -in "$CER_FILE" -out "$CER_PEM" 2>/dev/null; then
      echo "Converted DER certificate to PEM."
    else
      cp "$CER_FILE" "$CER_PEM"
      echo "Certificate already PEM-encoded."
    fi
    chmod 600 "$CER_PEM"

    echo ""
    echo "You will be asked twice for an export password for the .p12 bundle,"
    echo "then once more to unlock it during import. Use the same value."
    echo "It is never echoed or stored."
    echo ""

    # -passout stdin is avoided: openssl prompts interactively for the password,
    # so it never appears in argv or shell history.
    #
    # The legacy algorithm flags are REQUIRED. OpenSSL 3.x defaults to a
    # SHA-256 MAC with AES encryption, which Apple's SecurityFramework cannot
    # read — `security import` then fails with the misleading
    # "MAC verification failed during PKCS12 import (wrong password?)".
    # We ask for SHA-1 + 3DES explicitly rather than using `-legacy`, because
    # `-legacy` selects RC2-40 for certs and needs the legacy provider loaded.
    openssl pkcs12 -export \
      -macalg sha1 \
      -certpbe PBE-SHA1-3DES \
      -keypbe PBE-SHA1-3DES \
      -inkey "$KEY_FILE" \
      -in "$CER_PEM" \
      -out "$P12_FILE" \
      -name "Developer ID Application"
    chmod 600 "$P12_FILE"
    echo "Created $P12_FILE"

    echo ""
    echo "Importing into the login keychain..."
    security import "$P12_FILE" \
      -k "$HOME/Library/Keychains/login.keychain-db" \
      -T /usr/bin/codesign \
      -T /usr/bin/security

    echo ""
    show_identities
    echo ""
    IDENTITY="$(security find-identity -v -p codesigning \
      | sed -n 's/.*"\(Developer ID Application:.*\)"/\1/p' | head -1)"

    if [[ -n "$IDENTITY" ]]; then
      echo "=== Use this in .env.signing ==="
      echo "APPLE_SIGNING_IDENTITY=\"$IDENTITY\""
    elif security find-identity -p codesigning 2>/dev/null | grep -q "Developer ID Application"; then
      # The identity is in the keychain but is not valid. Almost always the
      # Apple "Developer ID" intermediate CA is missing, so the chain to the
      # Apple root cannot be built. This is NOT a wrong certificate type.
      # Note: under the Code Signing policy `security` does not print the
      # CSSMERR_* reason, so we detect "matching but not valid" instead; run
      # `security find-identity -p basic` to see the actual error string.
      cat >&2 <<'EOF'
WARNING: the identity imported but is not valid yet.

Reason (see `security find-identity -p basic`): usually CSSMERR_TP_NOT_TRUSTED.

The Apple "Developer ID" intermediate CA is missing from your keychain, so the
chain to the Apple root cannot be built. Your certificate itself is fine.

Fix it (G2 is what current certificates are issued from):

  curl -fLO https://www.apple.com/certificateauthority/DeveloperIDG2CA.cer
  open DeveloperIDG2CA.cer

Then re-run: ./scripts/signing-setup.sh --check
EOF
      exit 1
    else
      echo "WARNING: no 'Developer ID Application' identity showed up." >&2
      echo "Check that you downloaded a 'Developer ID Application' certificate" >&2
      echo "(not 'Apple Development' or 'Developer ID Installer')." >&2
      exit 1
    fi
    cat <<'EOF'

Note: the first time codesign uses this key, macOS shows a "codesign wants to
use key ..." dialog. Click "Always Allow" — otherwise the release build stalls
waiting on it. This is a one-time prompt per key.

Keep signing/developer-id.p12 and its export password: the .p12 is what you
base64 into the APPLE_CERTIFICATE repo secret for CI, and the password becomes
APPLE_CERTIFICATE_PASSWORD. Anyone holding both can sign software as you.

EOF
    echo "Next: cp .env.signing.example .env.signing, fill it in, then run"
    echo "  ./scripts/release-build.sh"
    exit 0
    ;;
esac
