# TEST-ONLY KEYPAIRS — DO NOT USE IN PRODUCTION

These ed25519 keypairs are committed to the repository **exclusively** for the
federation regression test suite. They are not secret and carry no trust outside
of local test environments.

| File | Instance | Public key |
|------|----------|------------|
| `poutine-a_ed25519.pem` | `poutine-a` | see `peers-b.yaml` |
| `poutine-b_ed25519.pem` | `poutine-b` | see `peers-a.yaml` |

To regenerate (if needed):
```bash
node -e "
const { generateKeyPairSync, createPublicKey } = require('crypto');
const { writeFileSync } = require('fs');
function gen(path) {
  const { privateKey } = generateKeyPairSync('ed25519');
  writeFileSync(path, privateKey.export({ format: 'pem', type: 'pkcs8' }), { mode: 0o600 });
  const raw = createPublicKey(privateKey).export({ format: 'der', type: 'spki' }).slice(-32);
  console.log('ed25519:' + raw.toString('base64'));
}
gen('poutine-a_ed25519.pem');
gen('poutine-b_ed25519.pem');
"
```
Then update `peers-a.yaml` and `peers-b.yaml` with the new public keys.
