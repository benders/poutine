# PR 103: Address Reviewer Comments

## Summary
Reviewer (benders) requested changes to the deterministic ID generation PR. The MBID-keyed path is solid, but the no-MBID fallback path has issues preventing cross-peer ID stability.

## Must Fix Issues

### 1. Fallback IDs hash raw `name`/`title`, not normalized form
- **Problem**: Two peers with "The Beatles" vs "Beatles" group together via `normalizeName` but pick different `group[0]` representatives, producing different artist IDs
- **Fix**: Hash on the already-computed `nameNormalized` (and `normalizeName(title)` for tracks)
- **Files**: `hub/src/library/id-generator.ts`, `hub/src/library/merge.ts`
- **Status**: ✅ FIXED - All ID generator functions now accept normalized names, merge.ts updated to pass `nameNormalized`

### 2. Broken `.get()` calls in new merge tests
- **Problem**: 4 tests call `db.prepare("SELECT ... WHERE ...").get()` without binding parameters
- **Affected tests**: Lines ~310, 337, 354, 371 in `hub/test/merge.test.ts`
- **Fix**: Add the missing parameter bindings
- **Status**: ✅ FIXED - All `.get()` calls now have proper parameter bindings

## Smaller Notes

### 3. Use NUL delimiter instead of `|`
- **Problem**: Pipes are legal in titles ("Verse | Chorus")
- **Fix**: Use `\0` delimiter or include lengths in `generateDeterministicId`
- **Status**: ✅ FIXED - Changed delimiter from `|` to `\0`

### 4. Fix asymmetry in `generateTrackId` defaults
- **Problem**: `discNumber?.toString() ?? "1"` vs `trackNumber?.toString() ?? "null"` - inconsistent sentinels
- **Fix**: Use `"null"` for both for consistency
- **Status**: ✅ FIXED - Both now use `"null"` sentinel

### 5. Reduce heavy JSDoc
- **Problem**: Heavy JSDoc on every function duplicates what names convey
- **Fix**: Remove excessive JSDoc, follow project's terse code style
- **Status**: ✅ FIXED - Removed all JSDoc comments from id-generator.ts

## Follow-up Question

### Migration concern
- Existing prod DBs reference old random UUIDs. After deploy, next merge changes every unified ID.
- Need to confirm #48 covers migration or add operator note
- **Action**: Post question as reply to PR
- **Status**: ✅ POSTED - Commented on PR asking about migration strategy options

## Verification

- ✅ TypeScript compilation passes (`tsc --noEmit`)
- ✅ `id-generator.test.ts` passes all 24 tests
- ⚠️ `merge.test.ts` - Environment issue (better-sqlite3 native module build failure due to missing Python)
- ✅ Changes pushed to `feat/deterministic-ids` branch

## Next Steps

Waiting for reviewer response on migration strategy question.
