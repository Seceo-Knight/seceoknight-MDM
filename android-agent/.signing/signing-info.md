# SeceoKnight MDM — Android Signing Info

**PRIVATE REPO ONLY — never make this repo public while this file is here.**

---

## Debug Keystore (used for all current builds)

| Field | Value |
|-------|-------|
| File | `.signing/debug.keystore` |
| Alias | `androiddebugkey` |
| Store password | `android` |
| Key password | `android` |
| Key algorithm | RSA 2048 |
| Validity | 10000 days |

---

## APK Signature Checksum

This value goes into the QR code for Device Owner provisioning.

```
PROVISIONING_DEVICE_ADMIN_SIGNATURE_CHECKSUM=Dw2eVmbw4E0sjfAbXDK70JhtazZcRnvwar-qvGj2aYA
```

**SHA-256 fingerprint (hex):**
```
0F:0D:9E:56:66:F0:E0:4D:2C:8D:F0:1B:5C:32:BB:D0:98:6D:6B:36:5C:46:7B:F0:6A:BF:AA:BC:68:F6:69:80
```

---

## QR Code Payload (for Device Owner provisioning)

The admin console uses this checksum to generate enrollment QR codes.
If you regenerate the keystore, you must recompute this value and update the server config.

### How to recompute after a new keystore

```bash
docker run --rm --platform linux/amd64 \
  -v ~/Downloads/seceoknight-MDM-main/android-agent/.signing:/ks \
  seceoknight-android-builder:latest bash -c "
    keytool -list -v -keystore /ks/debug.keystore -storepass android -alias androiddebugkey | grep 'SHA256:'
  "
# Then paste the hex output into:
python3 -c "
import sys, base64, binascii
hex_str = '0F0D9E...'  # replace with your hex, colons removed
raw = binascii.unhexlify(hex_str)
print(base64.urlsafe_b64encode(raw).rstrip(b'=').decode())
"
```

---

## On a new laptop

1. Copy `.signing/debug.keystore` from this repo to the new machine's `android-agent/.signing/`
2. The build script picks it up automatically — no regeneration needed
3. APK signature stays the same, so enrolled devices accept OTA updates without re-provisioning
