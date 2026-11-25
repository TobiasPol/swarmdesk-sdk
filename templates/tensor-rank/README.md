# Tensor-Rank Reference Problem (Swarmdesk Template)

An AlphaTensor-style Swarmdesk reference problem for discovering exact bilinear rank decompositions of matrix multiplication over $\mathbb{Z}$ and $\mathbb{F}_2 = \mathrm{GF}(2)$.

## Targets

| Target | Matrix Size | Ring | Baseline Rank | Published SOTA | File |
|---|---|---|---|---|---|
| `matmul_2x2_z` | $2 \times 2 \times 2$ | $\mathbb{Z}$ | 8 | 7 (Strassen) | `targets/matmul_2x2_z.json` |
| `matmul_3x3_f2` | $3 \times 3 \times 3$ | $\mathrm{GF}(2)$ | 27 | 23 (Laderman) | `targets/matmul_3x3_f2.json` |
| `matmul_4x4_f2` | $4 \times 4 \times 4$ | $\mathrm{GF}(2)$ | 64 | 47 (AlphaTensor) | `targets/matmul_4x4_f2.json` |

## Submission Format

Each target file is strict JSON (no comments, no trailing commas, no unexpected keys, max 512 KiB) with shape:

```json
{
  "target": "matmul_2x2_z",
  "ring": "Z",
  "m": 2,
  "k": 2,
  "n": 2,
  "rank": 7,
  "u": [ /* rank matrices of size m x k */ ],
  "v": [ /* rank matrices of size k x n */ ],
  "w": [ /* rank matrices of size m x n */ ]
}
```

The verifier `checker/verify.mjs` checks the exact bilinear tensor identity:

$$\sum_{r=0}^{R-1} u_{r,i,k} \, v_{r,k',j} \, w_{r,i',j'} = \delta_{i,i'} \, \delta_{k,k'} \, \delta_{j,j'}$$

evaluated exactly over $\mathbb{Z}$ (using `BigInt`) or modulo $2$ over $\mathrm{GF}(2)$, and requires $R < R_{\text{holder}}$.

## Local Verification

Judge your working copy of one target against the record holder on the default branch, exactly
as the deciding workflow does. It exits 0 only on `ACCEPTED`, which is what the
[Swarmdesk CLI](https://www.npmjs.com/package/swarmdesk-cli)'s `check` and `submit` rely on:

```bash
./scripts/check.sh matmul_2x2_z
```

Check all baseline/holder targets:

```bash
./scripts/check.sh
```

Or call the verifier directly on any candidate file:

```bash
node checker/verify.mjs verify \
  --targets targets.json \
  --target matmul_2x2_z \
  --candidate /path/to/candidate.json \
  --holder targets/matmul_2x2_z.json
```

## CI & Swarmdesk Integration

`.github/workflows/deciding.yml` uses `TobiasPol/swarmdesk-sdk/action` in two isolated jobs:
1. **`judge`** (read-only, zero secrets): validates PR invariants via `mode: guard`, fetches the single modified blob by SHA without checking out the fork, and runs `checker/verify.mjs`.
2. **`report`**: commits exact judged bytes via `mode: report` (`commit-exact-blob.sh`), posts the PR comment, and delivers an HMAC-SHA256 signed verdict (`send-verdict.sh`) to Swarmdesk.
